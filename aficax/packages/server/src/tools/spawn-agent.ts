// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\spawn-agent.ts
// `spawn_agent` tool: ask the agent to delegate a sub-task to a fresh
// sub-agent worker. The tool is gated behind `require_approval` because
// spawning a worker burns tokens the user is paying for.
//
// On a successful call the tool returns the worker's {@link TaskResult}
// as a Markdown block the parent model can fold into its next reply.

import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';

import {
  type SubAgentHandle,
  type SubAgentSpawner,
  type SpawnOptions,
  type TaskResult,
} from '../agents/index.js';
import type { ToolContext, ToolImplementation } from './registry.js';

/** Default per-worker timeout. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

/** Public configuration for the spawn_agent tool. */
export interface SpawnAgentToolOptions {
  /** Shared spawner instance (one per server). */
  readonly spawner: SubAgentSpawner;
  /** Provider / model inherited when the caller does not override. */
  readonly defaultProviderId: string;
  readonly defaultModelId: string;
  /**
   * Optional override of the per-worker timeout. Defaults to
   * {@link DEFAULT_TIMEOUT_MS}.
   */
  readonly defaultTimeoutMs?: number;
}

/** Definition + executor for the `spawn_agent` tool. */
export function createSpawnAgentTool(options: SpawnAgentToolOptions): ToolImplementation {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const definition: ToolDefinition = {
    name: 'spawn_agent',
    description:
      'Delegate a focused task to an isolated sub-agent. The sub-agent has ' +
      'its own context window, can use a restricted tool list, and reports ' +
      'back a summary plus the files it modified. Useful for parallel or ' +
      'exploratory work that would otherwise bloat the parent conversation. ' +
      'Always requires user approval before spawning.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Concrete description of the work the sub-agent should perform.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional whitelist of tool names the sub-agent may call. ' +
            'When omitted, the worker inherits the parent tool registry.',
        },
        model: {
          type: 'string',
          description: 'Optional model id override (e.g. "claude-haiku-4-5").',
        },
        provider: {
          type: 'string',
          description: 'Optional provider id override (e.g. "anthropic").',
        },
        maxTurns: {
          type: 'number',
          description: 'Maximum number of agent turns. Default 20.',
        },
        timeoutMs: {
          type: 'number',
          description: 'Per-worker timeout in ms. Default 10 minutes.',
        },
        workingDir: {
          type: 'string',
          description:
            'Working directory for the sub-agent. Defaults to the parent session cwd.',
        },
      },
      required: ['task'],
    },
    permissionLevel: 'require_approval',
  };

  return {
    definition,
    async execute(input, context: ToolContext): Promise<ToolResult> {
      const task = String(input['task'] ?? '');
      if (task.length === 0) {
        return { content: 'Error: "task" is required.', isError: true };
      }
      const toolsRaw = input['tools'];
      const tools: readonly string[] | undefined = Array.isArray(toolsRaw)
        ? toolsRaw.filter((t): t is string => typeof t === 'string')
        : undefined;
      const model = typeof input['model'] === 'string' ? input['model'] : undefined;
      const provider = typeof input['provider'] === 'string' ? input['provider'] : undefined;
      const maxTurnsRaw = input['maxTurns'];
      const maxTurns = typeof maxTurnsRaw === 'number' && maxTurnsRaw > 0 ? Math.floor(maxTurnsRaw) : undefined;
      const timeoutRaw = input['timeoutMs'];
      const timeoutMs = typeof timeoutRaw === 'number' && timeoutRaw > 0 ? Math.floor(timeoutRaw) : defaultTimeout;
      const cwdRaw = typeof input['workingDir'] === 'string' ? input['workingDir'] : undefined;
      const workingDir = cwdRaw
        ? (isAbsolute(cwdRaw) ? cwdRaw : resolve(context.workingDir, cwdRaw))
        : context.workingDir;

      const baseOptions = {
        task,
        workingDir,
        // Inherit the parent session's provider/model when the caller
        // does not supply an explicit override. This keeps sub-agents
        // working for users on local backends (Ollama, LM Studio)
        // instead of always falling back to the Anthropic defaults.
        providerId: provider ?? context.provider ?? options.defaultProviderId,
        modelId: model ?? context.model ?? options.defaultModelId,
      };
      const spawnOptions: SpawnOptions = {
        ...baseOptions,
        ...(tools !== undefined ? { tools } : {}),
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(timeoutMs !== defaultTimeout ? { timeoutMs } : {}),
      };

      const handle: SubAgentHandle = options.spawner.spawn(spawnOptions);

      let timeoutHandle: NodeJS.Timeout | undefined;
      const abortTimer = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          handle.abort();
          reject(new Error(`spawn_agent timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);
        // Allow the parent signal to abort the wait without aborting the
        // worker outright (the parent's abort policy is its own).
        context.signal?.addEventListener('abort', () => {
          clearTimeout(timeoutHandle);
          reject(new Error('parent aborted spawn_agent wait'));
        }, { once: true });
      });

      try {
        const result = await Promise.race([handle.wait(), abortTimer]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        return {
          content: formatTaskResult(result),
          isError: false,
          metadata: {
            workerId: handle.id,
            status: handle.status,
            endReason: result.endReason,
            totalTokens: result.totalTokens,
            filesModified: result.filesModified,
            durationMs: result.durationMs,
          },
        };
      } catch (err) {
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error: spawn_agent failed: ${message}`,
          isError: true,
          metadata: {
            workerId: handle.id,
            status: handle.status,
            filesModified: handle.filesModified,
          },
        };
      }
    },
  };
}

function formatTaskResult(result: TaskResult): string {
  const lines: string[] = [];
  lines.push(`# Sub-agent result (${result.workerId})`);
  lines.push(`Status: ${result.endReason} | Duration: ${String(result.durationMs)} ms | Tokens: ${String(result.totalTokens)}`);
  lines.push('');
  lines.push('## Summary');
  lines.push(result.summary.length > 0 ? result.summary : '(no summary)');
  if (result.finalMessage.length > 0 && result.finalMessage !== result.summary) {
    lines.push('', '## Final message', result.finalMessage);
  }
  if (result.filesModified.length > 0) {
    lines.push('', '## Files modified');
    for (const f of result.filesModified) lines.push(`- ${f}`);
  }
  if (result.errorMessage !== undefined) {
    lines.push('', `## Error`, result.errorMessage);
  }
  return lines.join('\n');
}
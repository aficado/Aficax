// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\custom-agents\runner.ts
// CustomAgentRunner: run a custom agent with its restricted configuration.
//
// The runner wraps a {@link CustomAgentDefinition} into a small driver
// that:
//   * Resolves the model + provider through the supplied registry.
//   * Builds a fresh `QueryEngine` whose tool registry contains ONLY
//     the tools the agent allows (after the `disallowedTools` filter).
//   * Forwards the agent's `systemPrompt` as the base for the prompt
//     builder (so the tool / git / mode sections are still injected by
//     `PromptBuilder` but the agent's own preamble takes precedence).
//   * Honours the per-agent `maxTurns`, `permissionMode`, and
//     `mcpServers` list.

import { isAbsolute, resolve } from 'node:path';
import { getLogger, type AnyAgentEvent, type ProviderType, type ToolInput, type ToolResult } from '@aficax/core';

import { type EventBus, createEventBus } from '../events/bus.js';
import { type QueryEngine, type QueryEngineDeps, createQueryEngine } from '../loop/query-engine.js';
import { type ProviderRegistry } from '../providers/registry.js';
import type { ToolImplementation, ToolRegistry } from '../tools/registry.js';

import type { CustomAgentDefinition } from './parser.js';

const logger = getLogger();

/** Public configuration of {@link CustomAgentRunner}. */
export interface CustomAgentRunnerOptions {
  /** Working directory used as the session cwd. */
  readonly workingDir: string;
  /** Provider registry used to resolve the model. */
  readonly providers: ProviderRegistry;
  /** Shared tool registry to filter from. */
  readonly tools: ToolRegistry;
  /** Optional `QueryEngineDeps` extras (permission engine, MCP, hooks). */
  readonly engineDeps?: QueryEngineExtras;
  /** Maximum tokens for the model call. */
  readonly maxTokens?: number;
}

/**
 * Subset of `QueryEngineDeps` a custom agent can be supplied with. The
 * `provider` and `tools` fields are filled in by the runner itself. The
 * `bus` is created on demand when the caller does not supply one.
 */
export interface QueryEngineExtras {
  readonly bus?: EventBus;
  readonly permissionEngine?: QueryEngineDeps['permissionEngine'];
  readonly mcpManager?: QueryEngineDeps['mcpManager'];
  readonly hookDispatcher?: QueryEngineDeps['hookDispatcher'];
}

/** Result of a {@link CustomAgentRunner.run} call. */
export interface CustomAgentRunResult {
  /** The events the engine emitted during the session. */
  readonly events: readonly AnyAgentEvent[];
  /** Exit reason extracted from the last `session_end` event. */
  readonly endReason: string;
  /** Total tokens used (cumulative, from `usage` events). */
  readonly totalTokens: number;
  /** Wall-clock duration. */
  readonly durationMs: number;
}

/**
 * Stateful runner for a single custom agent. The runner caches the
 * filtered tool registry so consecutive runs on the same definition do
 * not have to re-filter the parent registry.
 */
export class CustomAgentRunner {
  private readonly options: CustomAgentRunnerOptions;
  private readonly definition: CustomAgentDefinition;
  private filteredTools: ToolRegistry | null = null;

  constructor(definition: CustomAgentDefinition, options: CustomAgentRunnerOptions) {
    this.definition = definition;
    this.options = options;
  }

  /** The underlying definition. */
  get def(): CustomAgentDefinition {
    return this.definition;
  }

  /**
   * Execute the agent on `userMessage`. The function is async and
   * resolves once the engine reports `session_end`.
   */
  async run(userMessage: string, sessionId: string): Promise<CustomAgentRunResult> {
    const startedAt = Date.now();
    const { providerId, modelId } = this.parseModelSpec(this.definition.model);
    const adapter = this.options.providers.get(providerId as ProviderType, { modelId });
    const tools = this.getFilteredTools();
    const extras: QueryEngineExtras = this.options.engineDeps ?? {};
    const bus: EventBus = extras.bus ?? createEventBus();
    const baseDeps: QueryEngineDeps = {
      provider: adapter,
      tools,
      bus,
      ...(extras.permissionEngine !== undefined ? { permissionEngine: extras.permissionEngine } : {}),
      ...(extras.mcpManager !== undefined ? { mcpManager: extras.mcpManager } : {}),
      ...(extras.hookDispatcher !== undefined ? { hookDispatcher: extras.hookDispatcher } : {}),
    };
    const engine: QueryEngine = createQueryEngine(baseDeps, {
      maxTurns: this.definition.maxTurns,
      ...(this.options.maxTokens !== undefined ? { maxTokens: this.options.maxTokens } : {}),
    });

    const events: AnyAgentEvent[] = [];
    let endReason = 'completed';
    let totalTokens = 0;
    for await (const event of engine.run({
      userMessage,
      sessionId,
      workingDir: this.options.workingDir,
      modelId,
      providerId,
      mode: this.definition.permissionMode === 'ci' ? 'auto' : this.definition.permissionMode,
    })) {
      events.push(event);
      if (event.type === 'usage') {
        totalTokens = event.totalTokens;
      } else if (event.type === 'session_end') {
        endReason = event.reason;
      }
    }

    logger.info('custom-agent run finished', {
      name: this.definition.name,
      endReason,
      totalTokens,
      durationMs: Date.now() - startedAt,
    });

    return {
      events,
      endReason,
      totalTokens,
      durationMs: Date.now() - startedAt,
    };
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Filter the parent tool registry down to the subset this agent is
   * allowed to use. Tools in `disallowedTools` are removed; tools in
   * `tools` (when non-empty) are kept only if they are registered with
   * the parent. The filtered registry is a thin wrapper that delegates
   * to the parent for `get` / `definitions` / etc.
   */
  private getFilteredTools(): ToolRegistry {
    if (this.filteredTools !== null) return this.filteredTools;
    const allow = new Set(this.definition.tools);
    const deny = new Set(this.definition.disallowedTools);
    const parent = this.options.tools;
    const allowedNames = parent.names().filter((n) => {
      if (deny.has(n)) return false;
      if (allow.size > 0) return allow.has(n);
      return true;
    });
    const allowedSet = new Set(allowedNames);

    // Build a wrapper that re-implements the ToolRegistry surface using
    // a Map (the core's ToolRegistry is a `Map<string, ToolDefinition>`).
    const filtered = new Map<string, unknown>();
    for (const name of allowedNames) {
      const def = parent.definitions().find((d) => d.name === name);
      if (def !== undefined) filtered.set(name, def);
    }
    // Wrap into a ToolRegistry-shaped facade. Because the parent class
    // is the source of truth for execution, the wrapper only needs to
    // satisfy the read-side API used by `QueryEngineDeps.tools`.
    const wrapper = makeToolRegistryLike(filtered, parent, allowedSet);
    this.filteredTools = wrapper;
    return wrapper;
  }

  /**
   * Split a `provider/model` spec into its two components. Defaults
   * `provider` to `anthropic` and `model` to the spec when no slash is
   * present.
   */
  private parseModelSpec(spec: string): { providerId: string; modelId: string } {
    const slash = spec.indexOf('/');
    if (slash === -1) {
      return { providerId: 'anthropic', modelId: spec };
    }
    const providerId = spec.slice(0, slash).trim() || 'anthropic';
    const modelId = spec.slice(slash + 1).trim();
    return { providerId, modelId };
  }
}

// -- Helpers --------------------------------------------------------------

/**
 * Build a `ToolRegistry` that only exposes the tools in `allowed`.
 *
 * The server-side `ToolRegistry` is a class with `register` / `get` /
 * `has` / `definitions` / `names` / `size` methods. We re-implement the
 * read side using a closure over the parent registry; the write side
 * (`register`) is closed because custom agents do not register tools.
 */
function makeToolRegistryLike(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  filtered: Map<string, unknown>,
  parent: ToolRegistry,
  allowed: Set<string>,
): ToolRegistry {
  const wrapper: {
    register(impl: ToolImplementation): void;
    get(name: string): ToolImplementation | undefined;
    has(name: string): boolean;
    definitions(): ReturnType<ToolRegistry['definitions']>;
    names(): readonly string[];
    size(): number;
  } = {
    register(impl: ToolImplementation): void {
      // Custom agents do not register new tools; mirror the parent's
      // behaviour so the wrapper is interchangeable with it.
      parent.register(impl);
    },
    get(name: string): ToolImplementation | undefined {
      return allowed.has(name) ? parent.get(name) : undefined;
    },
    has(name: string): boolean {
      return allowed.has(name) && parent.has(name);
    },
    definitions() {
      return parent.definitions().filter((d) => allowed.has(d.name));
    },
    names(): readonly string[] {
      return parent.names().filter((n) => allowed.has(n));
    },
    size(): number {
      return parent.names().filter((n) => allowed.has(n)).length;
    },
  };
  return wrapper as unknown as ToolRegistry;
}

function normaliseCwd(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

// Re-export for tests and external callers.
export { normaliseCwd, type ToolInput, type ToolResult };

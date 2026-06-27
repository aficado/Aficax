// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\loop\query-engine.ts
// Main agent loop. Drives a ProviderAdapter, executes tool calls, and emits
// the AgentEvent stream consumed by the SSE endpoint.
//
// Responsibilities (in order, per turn):
//   1. Check {@link TokenBudgetTracker.shouldCompact}; if true, run the
//      three-level cascade from {@link CompactionEngine.compactCascade} and
//      emit `compaction` events.
//   2. Build the system prompt via {@link PromptBuilder.build} so each
//      section (git status, mode, MCP tools) is fresh.
//   3. Convert the {@link Message} history to the AI SDK's `CoreMessage`
//      shape and invoke the provider.
//   4. Feed `usage` chunks back into the token budget.
//   5. Run any tool calls, gated by the {@link PermissionEngine}.
//   6. Persist the assistant message + tool results into the message
//      history so the next turn sees them.

import {
  createSessionId,
  getLogger,
  isNearLimit,
  messageToText,
  type AnyAgentEvent,
  type CompactionEvent,
  type ErrorEvent,
  type Message,
  type MessageContent,
  type SessionId,
  type ToolCall as CoreToolCall,
  type ToolResult as CoreToolResult,
} from '@aficax/core';
import type { CoreMessage } from 'ai';

import type { EventBus } from '../events/bus.js';
import {
  type HookContext,
  type HookDispatcher,
  type HookResult,
} from '../hooks/index.js';
import type { McpManager } from '../mcp/manager.js';
import type { ProviderAdapter, StreamTextOptions } from '../providers/base.js';
import {
  type AgentMode,
  type PermissionCheckResult,
  PermissionEngine,
} from '../permissions/engine.js';
import { executeTool } from '../tools/executor.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';

import {
  type CompactionContext,
  CompactionEngine,
  type CompactionResult,
} from './compaction.js';
import {
  type PromptBuilderMcpTool,
  PromptBuilder,
  createPromptBuilder,
} from './prompt-builder.js';
import {
  TokenBudgetTracker,
  createTokenBudgetTracker,
} from './token-budget.js';

const logger = getLogger();

/** Stop reasons emitted in `MessageEndEvent.stopReason`. */
type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error';

/** Reason emitted in `SessionEndEvent.reason`. */
type EndReason = 'completed' | 'interrupted' | 'error' | 'max_turns';

/** Public configuration for the loop. All fields are optional. */
export interface QueryEngineOptions {
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  /** When `used/maxTokens >= this` the loop forces a compaction. */
  readonly compactionThreshold?: number;
  /** Maximum number of tokens a single tool output may consume. */
  readonly maxToolOutputTokens?: number;
  /** Optional override for the system prompt builder (tests). */
  readonly promptBuilder?: PromptBuilder;
  /** Optional override for the compaction engine (tests). */
  readonly compactionEngine?: CompactionEngine;
  /** Optional override for the token budget tracker (tests). */
  readonly tokenBudget?: TokenBudgetTracker;
}

/** Parameters accepted by {@link QueryEngine.run}. */
export interface RunParams {
  readonly userMessage: string;
  readonly sessionId: string;
  readonly workingDir: string;
  readonly modelId: string;
  readonly providerId: string;
  /** Agent permission mode. Defaults to `'auto'` when omitted. */
  readonly mode?: AgentMode;
  /** Optional MCP tools to surface in the system prompt. */
  readonly mcpTools?: readonly PromptBuilderMcpTool[];
  /** Files accessed in the last 5 turns (used by FullCompact). */
  readonly recentFiles?: readonly string[];
  /** Active plan from the most recent todo_write (used by FullCompact). */
  readonly activePlan?: string;
  readonly history?: readonly Message[];
  readonly signal?: AbortSignal;
}

/** Collaborators required by the loop. */
export interface QueryEngineDeps {
  readonly bus: EventBus;
  readonly tools: ToolRegistry;
  readonly provider: ProviderAdapter;
  /**
   * Permission gate consulted before every tool call. When omitted the
   * loop falls back to the legacy "always allow" behaviour so existing
   * callers (and unit tests) keep working.
   */
  readonly permissionEngine?: PermissionEngine;
  /**
   * Optional MCP manager. When provided, the loop calls
   * {@link McpManager.refreshTools} before each model invocation so the
   * tool list stays in sync with the connected servers.
   */
  readonly mcpManager?: McpManager;
  /**
   * Optional hook dispatcher. When provided, the loop fires
   * `OnSessionStart` / `PreAPICall` / `PostAPICall` / `PreToolUse` /
   * `PostToolUse` / `OnSessionEnd` / `OnError` events at the appropriate
   * lifecycle points and respects any `block: true` reply.
   */
  readonly hookDispatcher?: HookDispatcher;
}

/** A single tool invocation harvested from the provider stream. */
interface PendingToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

/** Outcome of running a tool. */
interface ToolOutcome {
  readonly result: CoreToolResult;
  readonly status: 'done' | 'error' | 'denied';
  readonly duration: number;
  readonly errorMessage?: string;
  /** Set when the permission gate caused the loop to abort (e.g. on Ctrl+C). */
  readonly permissionAbortedLoop?: boolean;
}

/** Main agent loop. */
export class QueryEngine {
  private readonly deps: QueryEngineDeps;
  private readonly options: Required<Omit<QueryEngineOptions,
    'promptBuilder' | 'compactionEngine' | 'tokenBudget'
  >>;
  private readonly promptBuilder: PromptBuilder;
  private readonly compactionEngine: CompactionEngine;
  private readonly tokenBudget: TokenBudgetTracker;
  /** Cumulative tokens used across the whole session (never reset by compaction). */
  private cumulativeTokens = 0;
  /** Set once after a successful MCP refresh so we don't refresh on every turn. */
  private lastMcpRefreshAt = 0;

  constructor(deps: QueryEngineDeps, options: QueryEngineOptions = {}) {
    this.deps = deps;
    this.options = {
      maxTurns: options.maxTurns ?? 50,
      maxTokens: options.maxTokens ?? 200_000,
      compactionThreshold: options.compactionThreshold ?? 0.85,
      maxToolOutputTokens: options.maxToolOutputTokens ?? 25_000,
    };
    this.promptBuilder = options.promptBuilder ?? createPromptBuilder();
    this.compactionEngine = options.compactionEngine ?? new CompactionEngine();
    this.tokenBudget =
      options.tokenBudget ??
      createTokenBudgetTracker(this.options.maxTokens, {
        compactionThreshold: this.options.compactionThreshold,
      });
  }

  /**
   * Run the loop for one user message. Yields every event the loop emits
   * (session lifecycle, tokens, tool calls, errors, ...). The generator
   * terminates when the loop ends for any reason.
   */
  async *run(params: RunParams): AsyncGenerator<AnyAgentEvent> {
    const sessionId = createSessionId(params.sessionId);
    const startTime = Date.now();
    const signal = params.signal;

    yield {
      type: 'session_start',
      sessionId,
      timestamp: Date.now(),
      model: params.modelId,
      provider: params.providerId,
      workingDir: params.workingDir,
    };

    const userMessage: Message = {
      id: makeMessageId('msg'),
      role: 'user',
      content: { kind: 'text', text: params.userMessage },
      timestamp: Date.now(),
    };

    const history = params.history ?? [];
    let currentMessages: Message[] = [...history, userMessage];

    let turn = 0;

    while (turn < this.options.maxTurns) {
      if (signal?.aborted === true) {
        yield this.endEvent(sessionId, 'interrupted', this.cumulativeTokens, Date.now() - startTime);
        return;
      }

      turn += 1;

      yield {
        type: 'status',
        sessionId,
        timestamp: Date.now(),
        status: 'thinking',
        detail: `Turn ${String(turn)}`,
      };

      const turnResult = await this.runOneTurn({
        messages: currentMessages,
        params,
        sessionId,
        startTime,
      });

      // If the turn was aborted while waiting on a permission prompt,
      // abandon the loop early so the user isn't billed for more turns.
      if (turnResult.abortedByPermission) {
        yield this.endEvent(sessionId, 'interrupted', this.cumulativeTokens, Date.now() - startTime);
        return;
      }

      for (const event of turnResult.events) {
        yield event;
      }

      if (turnResult.fatal) {
        yield this.endEvent(sessionId, 'error', this.cumulativeTokens, Date.now() - startTime);
        return;
      }

      if (turnResult.stopped) {
        yield this.endEvent(sessionId, 'completed', this.cumulativeTokens, Date.now() - startTime);
        return;
      }

      currentMessages = turnResult.nextMessages;
    }

    yield this.endEvent(sessionId, 'max_turns', this.cumulativeTokens, Date.now() - startTime);
  }

  // -- Internals ----------------------------------------------------------

  private async runOneTurn(args: {
    messages: Message[];
    params: RunParams;
    sessionId: SessionId;
    startTime: number;
  }): Promise<{
    events: AnyAgentEvent[];
    nextMessages: Message[];
    stopped: boolean;
    fatal: boolean;
    abortedByPermission: boolean;
  }> {
    const { params, sessionId } = args;
    const signal = params.signal;
    const events: AnyAgentEvent[] = [];
    // `workingMessages` carries the result of the compaction cascade, which
    // is exposed as a `readonly Message[]` from the engine. We treat it as
    // readonly here too; callers that need to append create a fresh array.
    let workingMessages: readonly Message[] = args.messages;
    let fatal = false;
    let abortedByPermission = false;

    // 0. Refresh MCP tool list (cheap when the manager has nothing to do,
    //    rate-limited to once every 5 s so we don't hammer servers).
    if (this.deps.mcpManager !== undefined) {
      const now = Date.now();
      if (now - this.lastMcpRefreshAt >= 5_000) {
        try {
          await this.deps.mcpManager.refreshTools();
          this.lastMcpRefreshAt = now;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.debug('MCP refresh failed', { error: message });
        }
      }
    }

    // 1. Compact if the budget is near the limit --------------------------
    if (this.tokenBudget.shouldCompact()) {
      const cascade = await this.runCompactionCascade(workingMessages, params, sessionId);
      for (const event of cascade.events) {
        events.push(event);
      }
      workingMessages = cascade.messages;
      if (!cascade.clearedBudget) {
        const errorEvt = this.compactionFailureEvent(sessionId);
        events.push(errorEvt);
      }
    }

    if (signal?.aborted === true) {
      return {
        events,
        nextMessages: [...workingMessages],
        stopped: true,
        fatal: false,
        abortedByPermission: false,
      };
    }

    // 2. Build the system prompt for this turn ----------------------------
    let systemPrompt: string;
    try {
      systemPrompt = await this.promptBuilder.build({
        sessionId: params.sessionId,
        cwd: params.workingDir,
        mode: params.mode ?? 'auto',
        mcpTools: params.mcpTools ?? [],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('PromptBuilder.build failed, falling back to default', {
        error: message,
      });
      events.push(this.errorEvent(sessionId, `system prompt build failed: ${message}`, false));
      systemPrompt = DEFAULT_SYSTEM_PROMPT;
    }

    // 3. Convert Message[] → CoreMessage[] and call the provider ----------
    const coreMessages = this.toCoreMessages(workingMessages);
    const streamOptions: StreamTextOptions = {};
    if (signal !== undefined) {
      streamOptions.signal = signal;
    }
    if (this.options.maxTokens > 0) {
      streamOptions.maxTokens = Math.min(this.options.maxTokens, 16_384);
    }

    // 3a. PreAPICall hook — let the user / a script inspect (or block) the
    //     pending API call before we burn tokens. Token estimate is the
    //     sum of every message's precomputed or estimated token count.
    if (this.deps.hookDispatcher !== undefined) {
      const tokenEstimate = workingMessages.reduce(
        (acc, m) => acc + (m.tokenCount ?? Math.ceil(JSON.stringify(m.content).length / 4)),
        0,
      );
      const pre = await this.safeDispatch({
        event: 'PreAPICall',
        sessionId,
        messageCount: workingMessages.length,
        tokenEstimate,
        model: params.modelId,
      });
      if (pre.blocked) {
        events.push(this.hookBlockedEvent(sessionId, 'PreAPICall', pre));
        return {
          events,
          nextMessages: [...workingMessages],
          stopped: true,
          fatal: false,
          abortedByPermission: false,
        };
      }
    }

    const pendingToolCalls: PendingToolCall[] = [];
    let textAccumulated = '';
    let sawFatal = false;
    let stopReason: StopReason = 'end_turn';

    try {
      const stream = this.deps.provider.streamText(
        coreMessages,
        this.deps.tools,
        systemPrompt,
        streamOptions,
      );

      events.push({
        type: 'message_start',
        sessionId,
        timestamp: Date.now(),
        role: 'assistant',
      });

      for await (const chunk of stream) {
        // Re-evaluate the abort flag on every chunk. We compare with a
        // boolean to side-step the `false | undefined` narrowing that the
        // optional chain produces inside the loop body.
        if (signal !== undefined && signal.aborted) {
          break;
        }
        switch (chunk.type) {
          case 'text': {
            textAccumulated += chunk.text;
            events.push({
              type: 'token',
              sessionId,
              timestamp: Date.now(),
              text: chunk.text,
            });
            break;
          }
          case 'tool_use': {
            pendingToolCalls.push({
              id: chunk.toolCallId,
              name: chunk.toolName,
              input: chunk.input,
            });
            break;
          }
          case 'usage': {
            // Update the budget from real usage, then forward to the TUI.
            this.tokenBudget.update(chunk.inputTokens, chunk.outputTokens);
            this.cumulativeTokens += chunk.inputTokens + chunk.outputTokens;
            const usageEvent: AnyAgentEvent = {
              type: 'usage',
              sessionId,
              timestamp: Date.now(),
              inputTokens: chunk.inputTokens,
              outputTokens: chunk.outputTokens,
              totalTokens: chunk.inputTokens + chunk.outputTokens,
            };
            const modelInfo = this.deps.provider.getModelInfo();
            const costPerInput = modelInfo.costPerInputToken ?? 0;
            const costPerOutput = modelInfo.costPerOutputToken ?? 0;
            const estimatedCost =
              chunk.inputTokens * costPerInput + chunk.outputTokens * costPerOutput;
            if (estimatedCost > 0) {
              (usageEvent as { estimatedCost?: number }).estimatedCost = estimatedCost;
            }
            events.push(usageEvent);

            if (isNearLimit(
              this.tokenBudget.tokensUsed,
              this.tokenBudget.usableWindow,
              this.options.compactionThreshold,
            )) {
              logger.warn('Token usage approaching limit', {
                sessionId: params.sessionId,
                totalTokens: this.tokenBudget.tokensUsed,
                limit: this.tokenBudget.usableWindow,
              });
            }
            break;
          }
          case 'error': {
            const isFatal = isLikelyFatalError(chunk.error);
            events.push(this.errorEvent(sessionId, chunk.error.message, isFatal));
            if (isFatal) {
              sawFatal = true;
            }
            break;
          }
        }
      }

      stopReason = pendingToolCalls.length > 0 ? 'tool_use' : 'end_turn';
      events.push({
        type: 'message_end',
        sessionId,
        timestamp: Date.now(),
        stopReason,
      });

      // 3b. PostAPICall hook — let a script inspect (or block) the model's
      //     final reply before the rest of the turn runs. Token usage is
      //     the running cumulative, not per-call (callers can compare
      //     against a pre-call snapshot if they care).
      if (this.deps.hookDispatcher !== undefined) {
        const post = await this.safeDispatch({
          event: 'PostAPICall',
          sessionId,
          response: textAccumulated,
          tokenUsage: {
            input: 0,
            output: this.cumulativeTokens,
          },
        });
        if (post.blocked) {
          events.push(this.hookBlockedEvent(sessionId, 'PostAPICall', post));
          return {
            events,
            nextMessages: [...workingMessages],
            stopped: true,
            fatal: false,
            abortedByPermission: false,
          };
        }
      }

      if (sawFatal) {
        fatal = true;
        return {
          events,
          nextMessages: [...workingMessages],
          stopped: true,
          fatal,
          abortedByPermission,
        };
      }

      // No tool calls → model finished.
      if (pendingToolCalls.length === 0) {
        return {
          events,
          nextMessages: appendAssistantText(workingMessages, textAccumulated),
          stopped: true,
          fatal,
          abortedByPermission,
        };
      }

      // 4. Execute every tool the model asked for, in order. -------------
      const toolOutcomes: Array<{
        tc: PendingToolCall;
        outcome: ToolOutcome;
      }> = [];
      for (const tc of pendingToolCalls) {
        const outcome = await this.runOneTool(tc, params, sessionId, events);
        toolOutcomes.push({ tc, outcome });
        if (outcome.permissionAbortedLoop === true) {
          abortedByPermission = true;
          break;
        }
      }

      if (abortedByPermission) {
        return {
          events,
          nextMessages: appendAssistantText(workingMessages, textAccumulated),
          stopped: true,
          fatal: false,
          abortedByPermission: true,
        };
      }

      const nextMessages = appendAssistantAndToolResults(
        workingMessages,
        textAccumulated,
        toolOutcomes,
      );
      return {
        events,
        nextMessages,
        stopped: false,
        fatal,
        abortedByPermission,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('QueryEngine turn failed', {
        sessionId: params.sessionId,
        error: message,
      });
      events.push(this.errorEvent(sessionId, message, true));
      return {
        events,
        nextMessages: [...workingMessages],
        stopped: true,
        fatal: true,
        abortedByPermission,
      };
    }
  }

  private async runOneTool(
    tc: PendingToolCall,
    params: RunParams,
    sessionId: SessionId,
    events: AnyAgentEvent[],
  ): Promise<ToolOutcome> {
    const start = Date.now();
    const initialCall: CoreToolCall = {
      id: tc.id,
      toolName: tc.name,
      input: tc.input,
      status: 'running',
    };

    events.push({
      type: 'tool_start',
      sessionId,
      timestamp: start,
      toolCall: initialCall,
    });

    // -- PreToolUse hook -----------------------------------------------
    // Fires BEFORE the permission gate so a hook can short-circuit a
    // dangerous call without ever asking the user. Hooks that want to
    // modify the tool input should reply with `{ modifiedContext: ... }`.
    if (this.deps.hookDispatcher !== undefined) {
      const pre = await this.safeDispatch({
        event: 'PreToolUse',
        sessionId,
        toolName: tc.name,
        input: tc.input,
        workingDir: params.workingDir,
      });
      if (pre.blocked) {
        events.push(this.hookBlockedEvent(sessionId, 'PreToolUse', pre));
        const content = `Tool "${tc.name}" was blocked by a hook: ${pre.blockReason ?? 'no reason given'}`;
        const result: CoreToolResult = {
          content,
          isError: true,
          metadata: {
            blockedByHook: true,
            reason: pre.blockReason ?? null,
          },
        };
        const finalCall: CoreToolCall = {
          id: tc.id,
          toolName: tc.name,
          input: tc.input,
          output: content,
          status: 'denied',
          duration: Date.now() - start,
          errorMessage: pre.blockReason ?? 'blocked by hook',
        };
        events.push({
          type: 'tool_end',
          sessionId,
          timestamp: Date.now(),
          toolCall: finalCall,
          result,
        });
        return {
          result,
          status: 'denied',
          duration: Date.now() - start,
          errorMessage: pre.blockReason ?? 'blocked by hook',
        };
      }
    }

    // -- Permission gate ------------------------------------------------
    const permissionEngine = this.deps.permissionEngine;
    if (permissionEngine !== undefined) {
      let verdict: PermissionCheckResult;
      try {
        verdict = await permissionEngine.checkPermission({
          toolName: tc.name,
          input: tc.input,
          toolCallId: tc.id,
          sessionId,
          workingDir: params.workingDir,
          mode: params.mode ?? 'auto',
          // Spread only when defined: `exactOptionalPropertyTypes` rejects
          // an explicit `undefined` for an optional property.
          ...(params.signal !== undefined ? { signal: params.signal } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('PermissionEngine.checkPermission threw, denying', {
          toolName: tc.name,
          sessionId,
          error: message,
        });
        verdict = {
          decision: 'deny',
          reason: 'aborted_denied',
          risk: 'high',
          denied: true,
        };
      }

      if (verdict.denied) {
        const denialReason = this.humanReason(verdict);
        const content = `Tool "${tc.name}" was denied: ${denialReason}`;
        const result: CoreToolResult = {
          content,
          isError: true,
          metadata: {
            denied: true,
            reason: verdict.reason,
            risk: verdict.risk,
            decision: verdict.decision,
          },
        };
        const finalCall: CoreToolCall = {
          id: tc.id,
          toolName: tc.name,
          input: tc.input,
          output: content,
          status: 'denied',
          duration: Date.now() - start,
          errorMessage: denialReason,
        };
        events.push({
          type: 'tool_end',
          sessionId,
          timestamp: Date.now(),
          toolCall: finalCall,
          result,
        });

        const aborted =
          verdict.reason === 'aborted_denied' || verdict.reason === 'timeout_denied';
        return {
          result,
          status: 'denied',
          duration: Date.now() - start,
          errorMessage: denialReason,
          ...(aborted ? { permissionAbortedLoop: true } : {}),
        };
      }
    }

    const impl = this.deps.tools.get(tc.name);
    if (!impl) {
      const result: CoreToolResult = {
        content: `Error: tool "${tc.name}" is not registered.`,
        isError: true,
      };
      const finalCall: CoreToolCall = {
        ...initialCall,
        status: 'error',
        output: result.content,
        errorMessage: 'not registered',
        duration: Date.now() - start,
      };
      events.push({
        type: 'tool_end',
        sessionId,
        timestamp: Date.now(),
        toolCall: finalCall,
        result,
      });
      return {
        result,
        status: 'error',
        errorMessage: 'not registered',
        duration: Date.now() - start,
      };
    }

    const ctx: ToolContext = this.buildContext(params);

    const exec = await executeTool(impl, tc.input, ctx);
    const status: 'done' | 'error' = exec.result.isError ? 'error' : 'done';
    const truncated = this.truncateToolOutput(exec.result.content);
    const finalResult: CoreToolResult = {
      ...exec.result,
      content: truncated,
    };
    const finalCall: CoreToolCall = {
      id: tc.id,
      toolName: tc.name,
      input: tc.input,
      output: truncated,
      status,
      duration: exec.duration,
    };
    if (status === 'error') {
      (finalCall as { errorMessage?: string }).errorMessage = truncated;
    }

    events.push({
      type: 'tool_end',
      sessionId,
      timestamp: Date.now(),
      toolCall: finalCall,
      result: finalResult,
    });

    // -- PostToolUse hook ----------------------------------------------
    // Fire-and-forget on the synchronous happy path: a blocking reply
    // here would discard a result the model has already seen, so we only
    // log the outcome. Hooks that need to redact secrets / re-format the
    // output should run in a `PreAPICall` hook on the next turn.
    if (this.deps.hookDispatcher !== undefined) {
      void this.safeDispatch({
        event: 'PostToolUse',
        sessionId,
        toolName: tc.name,
        input: tc.input,
        output: finalResult.content,
        durationMs: exec.duration,
        isError: status === 'error',
      });
    }

    return {
      result: finalResult,
      status,
      duration: exec.duration,
    };
  }

  /** Build a one-line explanation of a denial verdict for the model. */
  private humanReason(verdict: PermissionCheckResult): string {
    if (verdict.request !== undefined) {
      return verdict.request.reason;
    }
    switch (verdict.reason) {
      case 'mode_denied':
        return `current mode (${verdict.risk}) does not allow this tool`;
      case 'denylist_match':
        return 'this tool invocation matches a user-configured denylist entry';
      case 'tool_always_deny':
        return 'this tool is always denied';
      case 'aborted_denied':
        return 'denied because the request was aborted';
      case 'timeout_denied':
        return 'denied because the user did not respond within the timeout';
      default:
        return 'denied by the permission engine';
    }
  }

  /** Truncate over-long tool output to keep the context window in check. */
  private truncateToolOutput(content: string): string {
    const maxChars = this.options.maxToolOutputTokens * 4;
    if (content.length <= maxChars) {
      return content;
    }
    const head = content.slice(0, Math.floor(maxChars * 0.7));
    const tail = content.slice(-Math.floor(maxChars * 0.2));
    const omitted = content.length - head.length - tail.length;
    return `${head}\n\n…(${String(omitted)} characters truncated)…\n\n${tail}`;
  }

  private buildContext(params: RunParams): ToolContext {
    // Inherit the parent session's provider/model so sub-agents spawned
    // by tools like `spawn_agent` default to the same backend instead of
    // a hardcoded "anthropic" + "claude-sonnet-4-6" pair.
    const inherited = {
      sessionId: params.sessionId,
      workingDir: params.workingDir,
      provider: params.providerId,
      model: params.modelId,
    };
    if (params.signal === undefined) {
      return inherited;
    }
    return { ...inherited, signal: params.signal };
  }

  // -- Compaction cascade -----------------------------------------------

  private async runCompactionCascade(
    messages: readonly Message[],
    params: RunParams,
    sessionId: SessionId,
  ): Promise<{
    readonly messages: readonly Message[];
    readonly events: AnyAgentEvent[];
    readonly clearedBudget: boolean;
  }> {
    const ctx: CompactionContext = {
      provider: this.deps.provider,
      budget: this.tokenBudget,
      workingDir: params.workingDir,
      ...(params.signal !== undefined ? { signal: params.signal } : {}),
      ...(params.recentFiles !== undefined ? { recentFiles: params.recentFiles } : {}),
      ...(params.activePlan !== undefined ? { activePlan: params.activePlan } : {}),
    };
    const result = await this.compactionEngine.compactCascade(messages, ctx);
    const events: AnyAgentEvent[] = result.results.map((r) => this.compactionEvent(r, sessionId));
    return {
      messages: result.messages,
      events,
      clearedBudget: result.clearedBudget,
    };
  }

  private compactionEvent(result: CompactionResult, sessionId: SessionId): CompactionEvent {
    return {
      type: 'compaction',
      sessionId,
      timestamp: Date.now(),
      level: result.level,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
    };
  }

  private compactionFailureEvent(sessionId: SessionId): ErrorEvent {
    return {
      type: 'error',
      sessionId,
      timestamp: Date.now(),
      error:
        'context compaction failed to bring token usage below the threshold; ' +
        'continuing with the compacted history but the next turn may also be at risk',
      fatal: false,
    };
  }

  // -- Hook helpers -----------------------------------------------------

  /**
   * Run a hook through the dispatcher, catching every error so a buggy
   * or slow hook can never take the loop down. Returns the result; when
   * the dispatcher is missing the result has `blocked: false` and no
   * errors.
   */
  private async safeDispatch(context: HookContext): Promise<HookResult> {
    const dispatcher = this.deps.hookDispatcher;
    if (dispatcher === undefined) {
      return { blocked: false, context, errors: [], durationMs: 0 };
    }
    try {
      return await dispatcher.dispatch(context.event, context);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('hook dispatcher threw', { event: context.event, error: message });
      return { blocked: false, context, errors: [], durationMs: 0 };
    }
  }

  /** Emit a `error` event when a hook blocks an operation. */
  private hookBlockedEvent(
    sessionId: SessionId,
    event: HookContext['event'],
    result: HookResult,
  ): ErrorEvent {
    return {
      type: 'error',
      sessionId,
      timestamp: Date.now(),
      error: `operation blocked by ${event} hook: ${result.blockReason ?? 'no reason given'}`,
      fatal: false,
    };
  }

  // -- Message ↔ CoreMessage conversion ---------------------------------

  private toCoreMessages(messages: readonly Message[]): CoreMessage[] {
    const out: CoreMessage[] = [];
    for (const m of messages) {
      const mapped = this.mapOneMessage(m);
      if (mapped !== null) {
        out.push(mapped);
      }
    }
    return out;
  }

  private mapOneMessage(m: Message): CoreMessage | null {
    const content: MessageContent = m.content;
    switch (content.kind) {
      case 'text': {
        const role: 'user' | 'assistant' | 'system' =
          m.role === 'user' || m.role === 'assistant' || m.role === 'system'
            ? m.role
            : 'user';
        return { role, content: content.text } as CoreMessage;
      }
      case 'tool_use': {
        return {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: content.toolCallId,
              toolName: content.toolName,
              args: content.input,
            },
          ],
        } as unknown as CoreMessage;
      }
      case 'tool_result': {
        return {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: content.toolCallId,
              toolName: content.toolName,
              result: content.content,
              isError: content.isError,
            },
          ],
        } as CoreMessage;
      }
    }
  }

  private errorEvent(sessionId: SessionId, message: string, fatal: boolean): ErrorEvent {
    return {
      type: 'error',
      sessionId,
      timestamp: Date.now(),
      error: message,
      fatal,
    };
  }

  private endEvent(
    sessionId: SessionId,
    reason: EndReason,
    totalTokens: number,
    duration: number,
  ): AnyAgentEvent {
    return {
      type: 'session_end',
      sessionId,
      timestamp: Date.now(),
      reason,
      totalTokens,
      duration,
    };
  }

  // -- Unused helpers retained for future use -----------------------------

  /** @internal */
  protected textFallback(m: Message): string {
    return messageToText(m);
  }
}

/** Heuristic: is the error fatal (i.e. the stream is unrecoverable)? */
function isLikelyFatalError(err: Error): boolean {
  const message = err.message.toLowerCase();
  if (message.includes('api key') || message.includes('unauthorized') || message.includes('401')) {
    return true;
  }
  if (message.includes('not found') || message.includes('404')) {
    return false;
  }
  if (message.includes('rate limit') || message.includes('429')) {
    return false;
  }
  if (message.includes('timeout') || message.includes('timed out')) {
    return false;
  }
  if (message.includes('abort')) {
    return false;
  }
  return true;
}

/** Minimal fallback system prompt used only when the builder throws. */
const DEFAULT_SYSTEM_PROMPT = [
  'You are Aficax, an AI assistant specialised in software development.',
  'Use the provided tools to read and modify files, run shell commands, and search code.',
  'Be concise, accurate, and respect the user\'s approval prompts.',
  'When a task is ambiguous, ask a clarifying question rather than guessing.',
].join(' ');

/** Append the assistant text reply (if any) to the message history. */
function appendAssistantText(messages: readonly Message[], text: string): Message[] {
  if (text.length === 0) return [...messages];
  const assistantMessage: Message = {
    id: makeMessageId('msg'),
    role: 'assistant',
    content: { kind: 'text', text },
    timestamp: Date.now(),
  };
  return [...messages, assistantMessage];
}

/**
 * Append the assistant reply + every tool call + every tool result to the
 * history. The core `Message` shape only carries one content per message, so
 * the AI SDK's "assistant content array" is materialised as one text message
 * followed by interleaved `tool_use` / `tool_result` messages.
 */
function appendAssistantAndToolResults(
  messages: readonly Message[],
  text: string,
  outcomes: ReadonlyArray<{ readonly tc: PendingToolCall; readonly outcome: ToolOutcome }>,
): Message[] {
  const next = appendAssistantText(messages, text);
  const now = Date.now();
  for (const { tc, outcome } of outcomes) {
    // The model's call: stored as a `tool_use` message so the next turn
    // can pair it with the matching `tool_result` below.
    const toolUseMessage: Message = {
      id: makeMessageId('msg'),
      role: 'tool_use',
      content: {
        kind: 'tool_use',
        toolCallId: tc.id,
        toolName: tc.name,
        input: tc.input,
      },
      timestamp: now,
    };
    next.push(toolUseMessage);

    // The tool's reply: paired with the call by `toolCallId`.
    const toolResultMessage: Message = {
      id: makeMessageId('msg'),
      role: 'tool_result',
      content: {
        kind: 'tool_result',
        toolCallId: tc.id,
        toolName: tc.name,
        content: outcome.result.content,
        isError: outcome.result.isError,
      },
      timestamp: now,
    };
    next.push(toolResultMessage);
  }
  return next;
}

/** Generate a stable-ish message id without pulling in a uuid dependency. */
function makeMessageId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/** Factory that creates a fresh {@link QueryEngine}. */
export function createQueryEngine(deps: QueryEngineDeps, options?: QueryEngineOptions): QueryEngine {
  return new QueryEngine(deps, options);
}

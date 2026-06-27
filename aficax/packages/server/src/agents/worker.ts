// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\agents\worker.ts
// SubAgentWorker: an isolated agent loop that runs a single task end-to-end
// and reports back a {@link TaskResult}.
//
// A worker is, mechanically, a `QueryEngine` configured with a smaller
// turn budget, a possibly-restricted tool set, and a hard timeout. It has
// no knowledge of the parent conversation: the parent passes a fresh
// `history` (or none) and a `task` string, and the worker starts from
// scratch. The only output that crosses the boundary is the final
// `TaskResult`.
//
// Isolation guarantees
// --------------------
//   * The worker gets its own `QueryEngine` instance, so its tool
//     registry, prompt builder, and token budget are independent of
//     the parent's.
//   * The `history` argument is copied; mutations made by the worker
//     do not leak back.
//   * `AbortController` lets the parent stop a runaway worker.

import {
  estimateTokens,
  getLogger,
  type AnyAgentEvent,
  type Message,
  type SessionId,
} from '@aficax/core';

import { type QueryEngine, type RunParams, createQueryEngine } from '../loop/query-engine.js';

const logger = getLogger();

/** Final outcome of a sub-agent worker. */
export interface TaskResult {
  /** Stable id of the worker that produced this result. */
  readonly workerId: string;
  /** One-paragraph summary written by the worker. */
  readonly summary: string;
  /** Full text of the worker's last assistant message (when present). */
  readonly finalMessage: string;
  /** Files the worker modified (relative paths). */
  readonly filesModified: readonly string[];
  /** Cumulative tokens used by the worker. */
  readonly totalTokens: number;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
  /** How the worker terminated. */
  readonly endReason: 'completed' | 'interrupted' | 'error' | 'max_turns' | 'timeout';
  /** Final error message when `endReason` is `error`. */
  readonly errorMessage?: string;
}

/** Public configuration of {@link SubAgentWorker}. */
export interface SubAgentWorkerOptions {
  /** Provider / model inherited from the parent (passed through). */
  readonly providerId: string;
  readonly modelId: string;
  /** Working directory the worker operates in. */
  readonly workingDir: string;
  /** Mode inherited from the parent. */
  readonly mode?: 'plan' | 'auto' | 'full' | 'read-only';
  /** Maximum number of turns (default 20). */
  readonly maxTurns?: number;
  /** Per-call timeout in ms (default 10 minutes). */
  readonly timeoutMs?: number;
  /** Maximum tokens allowed for the worker (default 100k). */
  readonly maxTokens?: number;
  /** Tool names the worker is allowed to use. `undefined` = inherit all. */
  readonly tools?: readonly string[];
  /** Compaction threshold (default 0.85). */
  readonly compactionThreshold?: number;
  /** Stable id assigned to this worker. */
  readonly workerId?: string;
  /** Optional override of the engine factory (tests). */
  readonly engineFactory?: (providerId: string, modelId: string, workingDir: string) => QueryEngine;
}

/** Collaborators required by {@link SubAgentWorker}. */
export interface SubAgentWorkerDeps {
  /**
   * Factory that builds a `QueryEngine` for a given session. The parent
   * supplies its own `engineFactory` so the worker reuses the same
   * provider / permission wiring.
   */
  readonly engineFactory: (providerId: string, modelId: string, workingDir: string) => QueryEngine;
  /** Resolve the absolute path of a file the worker wrote, for tracking. */
  readonly toRelativePath?: (absolute: string) => string;
}

/** Result of {@link SubAgentWorker.run}. */
export interface SubAgentRunResult {
  readonly result: TaskResult;
  readonly events: readonly AnyAgentEvent[];
  readonly abort: () => void;
}

/**
 * Default per-worker turn cap. The parent gets 50; sub-agents get less
 * because they are usually scoped to a single sub-task.
 */
const DEFAULT_MAX_TURNS = 20;
/** Default per-worker wall-clock timeout (10 minutes). */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
/** Default per-worker token budget (100k tokens). */
const DEFAULT_MAX_TOKENS = 100_000;

/**
 * Single-task sub-agent. Constructed with the parent engine's
 * collaborators; runs a fresh `QueryEngine` with restricted options and
 * tracks the files it writes to surface them in the {@link TaskResult}.
 */
export class SubAgentWorker {
  private readonly deps: SubAgentWorkerDeps;
  private readonly options: Required<Omit<SubAgentWorkerOptions,
    'tools' | 'engineFactory' | 'mode' | 'workerId'
  >> & {
    readonly tools: readonly string[] | undefined;
    readonly mode: 'plan' | 'auto' | 'full' | 'read-only' | undefined;
    readonly workerId: string;
    readonly engineFactory: (providerId: string, modelId: string, workingDir: string) => QueryEngine;
  };
  private readonly modifiedFiles: Set<string> = new Set();
  private readonly abortController: AbortController = new AbortController();
  private status: 'running' | 'completed' | 'aborted' | 'errored' = 'running';

  constructor(deps: SubAgentWorkerDeps, options: SubAgentWorkerOptions) {
    this.deps = deps;
    this.options = {
      providerId: options.providerId,
      modelId: options.modelId,
      workingDir: options.workingDir,
      mode: options.mode,
      maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      compactionThreshold: options.compactionThreshold ?? 0.85,
      tools: options.tools,
      workerId: options.workerId ?? makeWorkerId(),
      engineFactory: options.engineFactory ?? this.deps.engineFactory,
    };
  }

  /** Unique id of this worker. */
  get id(): string {
    return this.options.workerId;
  }

  /** Current lifecycle status. */
  get currentStatus(): SubAgentWorker['status'] {
    return this.status;
  }

  /** Snapshot of the files the worker has modified so far. */
  get files(): readonly string[] {
    return Array.from(this.modifiedFiles);
  }

  /** Abort the worker. Idempotent. */
  abort(): void {
    if (this.status !== 'running') return;
    this.status = 'aborted';
    this.abortController.abort();
  }

  /**
   * Run the worker on `task` with the given (optional) starting
   * history. The returned {@link SubAgentRunResult} is observable while
   * the worker is in flight; the `result` is filled in once the loop
   * ends.
   */
  async run(task: string, history: readonly Message[] = []): Promise<SubAgentRunResult> {
    const startedAt = Date.now();
    const timeoutMs = this.options.timeoutMs;
    const timeoutHandle = setTimeout(() => {
      logger.warn('sub-agent worker timed out', {
        workerId: this.options.workerId,
        timeoutMs,
      });
      this.abort();
    }, Math.max(1, timeoutMs));

    const engine = this.deps.engineFactory(
      this.options.providerId,
      this.options.modelId,
      this.options.workingDir,
    );
    const params: RunParams = {
      userMessage: task,
      sessionId: `${this.options.workerId}-session` as SessionId,
      workingDir: this.options.workingDir,
      modelId: this.options.modelId,
      providerId: this.options.providerId,
      ...(this.options.mode !== undefined ? { mode: this.options.mode } : {}),
      history: [...history],
      signal: this.abortController.signal,
    };

    const events: AnyAgentEvent[] = [];
    let summary = '';
    let finalMessage = '';
    let totalTokens = 0;
    let endReason: TaskResult['endReason'] = 'completed';
    let errorMessage: string | undefined;

    try {
      for await (const event of engine.run(params)) {
        events.push(event);
        if (event.type === 'usage') {
          totalTokens = event.totalTokens;
        } else if (event.type === 'session_end') {
          endReason = event.reason;
        } else if (event.type === 'tool_end') {
          // Track write-like tools so the parent sees what changed.
          if (isWriteTool(event.toolCall.toolName)) {
            const absolute = readPathArg(event.toolCall.input);
            if (absolute !== null) {
              this.modifiedFiles.add(this.toRelative(absolute));
            }
          }
        }
      }
    } catch (err) {
      this.status = 'errored';
      errorMessage = err instanceof Error ? err.message : String(err);
      endReason = 'error';
      logger.error('sub-agent worker threw', { workerId: this.options.workerId, error: errorMessage });
    } finally {
      clearTimeout(timeoutHandle);
    }

    // The last assistant text message in the event stream is the worker's
    // final reply. Fall back to a generated summary if the model never
    // produced a text block (e.g. exited via tool calls only).
    finalMessage = lastAssistantText(events);
    if (finalMessage.length === 0) {
      finalMessage = '(worker produced no text output)';
    }
    summary = summarise(finalMessage);

    if (this.abortController.signal.aborted && endReason === 'completed') {
      endReason = this.status === 'aborted' ? 'interrupted' : endReason;
    }
    if (endReason === 'completed' && this.status === 'aborted') {
      endReason = 'interrupted';
    }
    if (totalTokens === 0) {
      totalTokens = estimateTokens(summary + finalMessage);
    }
    if (this.status === 'running') this.status = 'completed';

    const base: TaskResult = {
      workerId: this.options.workerId,
      summary,
      finalMessage,
      filesModified: Array.from(this.modifiedFiles),
      totalTokens,
      durationMs: Date.now() - startedAt,
      endReason,
    };
    const result: TaskResult = errorMessage !== undefined
      ? { ...base, errorMessage }
      : base;
    return {
      result,
      events,
      abort: () => this.abort(),
    };
  }

  // -- Internals ---------------------------------------------------------

  private toRelative(absolute: string): string {
    if (this.deps.toRelativePath !== undefined) {
      return this.deps.toRelativePath(absolute);
    }
    return absolute;
  }
}

// -- Helpers --------------------------------------------------------------

const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'multi_edit']);

function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

function readPathArg(input: Record<string, unknown>): string | null {
  const candidate = input['path'] ?? input['file'] ?? input['filepath'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

function lastAssistantText(events: readonly AnyAgentEvent[]): string {
  let buffer = '';
  for (const event of events) {
    if (event.type === 'token') {
      buffer += event.text;
    } else if (event.type === 'message_start') {
      buffer = '';
    } else if (event.type === 'message_end') {
      // Keep buffer; the next token event would reset it.
    }
  }
  return buffer.trim();
}

function summarise(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '(no summary)';
  // First paragraph up to ~280 chars.
  const firstBreak = trimmed.indexOf('\n\n');
  const head = firstBreak === -1 ? trimmed : trimmed.slice(0, firstBreak);
  if (head.length <= 280) return head;
  return `${head.slice(0, 277)}...`;
}

function makeWorkerId(): string {
  return `aficax-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Factory that creates a fresh {@link SubAgentWorker}. */
export function createSubAgentWorker(
  deps: SubAgentWorkerDeps,
  options: SubAgentWorkerOptions,
): SubAgentWorker {
  return new SubAgentWorker(deps, options);
}

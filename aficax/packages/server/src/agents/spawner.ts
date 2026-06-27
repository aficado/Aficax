// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\agents\spawner.ts
// SubAgentSpawner: creates, monitors, and terminates sub-agent workers.
//
// "Isolation" here is logical rather than OS-level. Each worker runs in
// the same Node process but has its own `QueryEngine` instance, its own
// `history`, its own `AbortController`, and a filtered `ToolRegistry`.
// The shared resources (the tool implementation map, the event bus, the
// permission engine) are referenced read-only.
//
// Concurrency
// -----------
// `spawn` always returns immediately with a handle. The actual loop
// runs as a detached promise that resolves when the worker finishes.
// `spawnParallel` enforces a configurable semaphore (default 4) so a
// misbehaving parent cannot fork-bomb the process.

import { getLogger } from '@aficax/core';

import { type SubAgentWorker, type SubAgentWorkerDeps, createSubAgentWorker } from './worker.js';
import type { TaskResult } from './worker.js';

const logger = getLogger();

/** Status a {@link SubAgentHandle} can be in. */
export type SubAgentStatus = 'pending' | 'running' | 'completed' | 'aborted' | 'errored';

/** Live handle to a running (or finished) sub-agent. */
export interface SubAgentHandle {
  /** Stable id of the worker. */
  readonly id: string;
  /** Current status. */
  readonly status: SubAgentStatus;
  /** The task string the worker was given. */
  readonly task: string;
  /** Files the worker has modified so far (live, updated as the loop runs). */
  readonly filesModified: readonly string[];
  /** Result once the worker finishes. `undefined` while in flight. */
  readonly result: TaskResult | undefined;
  /** Abort the worker. Safe to call from any state. */
  abort(): void;
  /** Resolves with the result when the worker finishes. */
  wait(): Promise<TaskResult>;
}

/** Public configuration of {@link SubAgentSpawner}. */
export interface SubAgentSpawnerOptions {
  readonly workerDeps: SubAgentWorkerDeps;
  /** Maximum concurrent workers. Default 4. */
  readonly maxConcurrent?: number;
  /** Default `maxTurns` for spawned workers. Default 20. */
  readonly defaultMaxTurns?: number;
  /** Default timeout per worker in ms. Default 10 minutes. */
  readonly defaultTimeoutMs?: number;
}

/** Options for a single {@link SubAgentSpawner.spawn} call. */
export interface SpawnOptions {
  /** Task description (becomes the first user message). */
  readonly task: string;
  /** Provider / model for the worker. */
  readonly providerId: string;
  readonly modelId: string;
  /** Working directory. */
  readonly workingDir: string;
  /** Mode inherited from the parent. */
  readonly mode?: 'plan' | 'auto' | 'full' | 'read-only';
  /** Optional tool allowlist. */
  readonly tools?: readonly string[];
  /** Optional override of the per-worker turn cap. */
  readonly maxTurns?: number;
  /** Optional override of the per-worker timeout. */
  readonly timeoutMs?: number;
  /** Optional override of the per-worker token budget. */
  readonly maxTokens?: number;
  /** Stable id to assign; one is generated when omitted. */
  readonly id?: string;
  /** Optional starting history. */
  readonly history?: readonly import('@aficax/core').Message[];
}

/**
 * Concurrency limiter used by `spawnParallel`. It exposes a single
 * `run` method that schedules a task once a slot is free.
 */
class Semaphore {
  private readonly max: number;
  private inFlight = 0;
  private readonly queue: Array<() => void> = [];

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight < this.max) {
      this.inFlight += 1;
      try {
        return await fn();
      } finally {
        this.inFlight -= 1;
        this.drain();
      }
    }
    return new Promise<T>((resolve, reject) => {
      this.queue.push(() => {
        this.inFlight += 1;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.inFlight -= 1;
            this.drain();
          });
      });
    });
  }

  private drain(): void {
    const next = this.queue.shift();
    if (next !== undefined) next();
  }
}

/**
 * Coordinates the lifecycle of every sub-agent worker the server spawns.
 * Construction is O(1); every public method is async.
 */
export class SubAgentSpawner {
  private readonly workerDeps: SubAgentWorkerDeps;
  private readonly maxConcurrent: number;
  private readonly defaultMaxTurns: number;
  private readonly defaultTimeoutMs: number;
  private readonly semaphore: Semaphore;
  private readonly active: Map<string, SubAgentHandle> = new Map();

  constructor(options: SubAgentSpawnerOptions) {
    this.workerDeps = options.workerDeps;
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.defaultMaxTurns = options.defaultMaxTurns ?? 20;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 10 * 60 * 1_000;
    this.semaphore = new Semaphore(this.maxConcurrent);
  }

  /** Maximum concurrent workers. */
  get concurrency(): number {
    return this.maxConcurrent;
  }

  /** Snapshot of every live handle. */
  list(): readonly SubAgentHandle[] {
    return Array.from(this.active.values());
  }

  /** Look up a single handle. */
  get(id: string): SubAgentHandle | undefined {
    return this.active.get(id);
  }

  /**
   * Spawn a single worker. Returns immediately with a handle; the
   * `wait()` promise resolves when the worker finishes.
   */
  spawn(options: SpawnOptions): SubAgentHandle {
    const id = options.id ?? makeHandleId();
    const worker = createSubAgentWorker(this.workerDeps, {
      providerId: options.providerId,
      modelId: options.modelId,
      workingDir: options.workingDir,
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      maxTurns: options.maxTurns ?? this.defaultMaxTurns,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
      ...(options.tools !== undefined ? { tools: options.tools } : {}),
      workerId: id,
    });

    const handle = makeHandle(worker, options.task, () => {
      this.active.delete(id);
    });
    this.active.set(id, handle);

    // Drive the worker inside the semaphore. The actual `run` is fired
    // without awaiting so the caller can chain `wait()` synchronously.
    void this.semaphore.run(async () => {
      try {
        const { result, abort } = await worker.run(options.task, options.history ?? []);
        handle.setResult(result);
        // Expose the abort closure in case `wait()` was used.
        handle.setAbort(abort);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error('sub-agent worker crashed', { id, error: message });
        handle.setError(message);
      } finally {
        // Hold the handle in the active list for a short window so a
        // late `list()` / `get()` call still sees it; the waitForExit
        // hook removes it once the consumer has observed the result.
        setTimeout(() => {
          if (this.active.get(id) === handle && handle.status !== 'running') {
            this.active.delete(id);
          }
        }, 5_000).unref?.();
      }
    });

    return handle;
  }

  /**
   * Spawn N workers in parallel. Returns the handles in the same order
   * as `options`. The semaphore caps real concurrency to
   * {@link SubAgentSpawner.concurrency}.
   */
  spawnParallel(optionsList: readonly SpawnOptions[]): SubAgentHandle[] {
    return optionsList.map((o) => this.spawn(o));
  }

  /**
   * Abort every active worker. Returns the number of handles aborted.
   */
  abortAll(): number {
    let count = 0;
    for (const handle of this.active.values()) {
      handle.abort();
      count += 1;
    }
    return count;
  }
}

function makeHandleId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Build the live {@link SubAgentHandle} wrapper around a worker. The
 * handle starts in `pending` status, transitions to `running` once the
 * loop yields its first event, and settles in `completed` / `aborted` /
 * `errored` when the loop ends.
 */
function makeHandle(worker: SubAgentWorker, task: string, onSettled: () => void): LiveHandle {
  const handle = new LiveHandle(worker, task, onSettled);
  return handle;
}

class LiveHandle implements SubAgentHandle {
  private readonly worker: SubAgentWorker;
  private _task: string;
  private _status: SubAgentStatus = 'pending';
  private _result: TaskResult | undefined;
  private _abort: () => void = () => {
    this._status = 'aborted';
    this.worker.abort();
    this.resolveWait({
      workerId: this.worker.id,
      summary: '(aborted before start)',
      finalMessage: '',
      filesModified: [],
      totalTokens: 0,
      durationMs: 0,
      endReason: 'interrupted',
    });
    this.onSettled();
  };
  private readonly onSettled: () => void;
  private waitPromise: Promise<TaskResult>;
  private resolveWait!: (result: TaskResult) => void;
  private rejectWait!: (err: Error) => void;
  private settled = false;

  constructor(worker: SubAgentWorker, task: string, onSettled: () => void) {
    this.worker = worker;
    this._task = task;
    this.onSettled = onSettled;
    this.waitPromise = new Promise<TaskResult>((resolve, reject) => {
      this.resolveWait = resolve;
      this.rejectWait = reject;
    });
  }

  get id(): string {
    return this.worker.id;
  }
  get status(): SubAgentStatus {
    return this._status;
  }
  get task(): string {
    return this._task;
  }
  get filesModified(): readonly string[] {
    return this.worker.files;
  }
  get result(): TaskResult | undefined {
    return this._result;
  }

  abort(): void {
    this._abort();
  }

  wait(): Promise<TaskResult> {
    return this.waitPromise;
  }

  setResult(result: TaskResult): void {
    if (this.settled) return;
    this.settled = true;
    this._result = result;
    if (result.endReason === 'error') this._status = 'errored';
    else if (result.endReason === 'interrupted' || result.endReason === 'timeout') this._status = 'aborted';
    else this._status = 'completed';
    this.resolveWait(result);
    this.onSettled();
  }

  setError(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this._status = 'errored';
    const result: TaskResult = {
      workerId: this.worker.id,
      summary: `(error) ${message}`,
      finalMessage: '',
      filesModified: this.worker.files,
      totalTokens: 0,
      durationMs: 0,
      endReason: 'error',
      errorMessage: message,
    };
    this._result = result;
    this.resolveWait(result);
    this.onSettled();
  }

  setAbort(abort: () => void): void {
    this._abort = () => {
      this._status = 'aborted';
      abort();
      this.onSettled();
    };
  }
}

/** Factory that creates a fresh {@link SubAgentSpawner}. */
export function createSubAgentSpawner(options: SubAgentSpawnerOptions): SubAgentSpawner {
  return new SubAgentSpawner(options);
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\agents\coordinator.ts
// Coordinator: runs a set of sub-agents in parallel and aggregates their
// outputs into a single {@link CoordinationResult} the parent agent can
// consume in one assistant turn.
//
// Use case
// --------
// The parent splits a complex task into N independent sub-tasks (e.g.
// "refactor these 3 modules in parallel"), spawns a worker for each one,
// waits for every handle to resolve, and then summarises the work.
//
// Approval gate
// -------------
// A worker may need to perform a risky action (e.g. `bash` with `rm`).
// When `approveRisk` is supplied, the coordinator invokes it BEFORE the
// worker is even spawned for the matching task, and the worker proceeds
// only when the gate says "allow". The function receives the worker's
// proposed task + tool allowlist and returns a verdict.

import { getLogger } from '@aficax/core';

import {
  type SubAgentHandle,
  type SubAgentSpawner,
  type SpawnOptions,
} from './spawner.js';
import type { TaskResult } from './worker.js';

const logger = getLogger();

/** A single sub-task handed to the coordinator. */
export interface CoordinateTask {
  /** Stable key (used in the merged result). */
  readonly key: string;
  /** Task description passed to the worker. */
  readonly task: string;
  /** Optional tool allowlist. */
  readonly tools?: readonly string[];
  /** Per-task provider / model override. */
  readonly providerId?: string;
  readonly modelId?: string;
  /** Per-task working directory override. */
  readonly workingDir?: string;
  /** Per-task max-turns override. */
  readonly maxTurns?: number;
  /** Per-task timeout override. */
  readonly timeoutMs?: number;
}

/** Aggregated result of {@link Coordinator.coordinate}. */
export interface CoordinationResult {
  /** The merged text the parent agent should see. */
  readonly summary: string;
  /** Per-key {@link TaskResult}. */
  readonly perTask: Readonly<Record<string, TaskResult>>;
  /** Concatenated list of files modified by every worker. */
  readonly filesModified: readonly string[];
  /** Total tokens used across all workers. */
  readonly totalTokens: number;
  /** Number of workers that finished with `endReason === 'error'`. */
  readonly errors: number;
  /** Number of workers that finished with `endReason === 'completed'`. */
  readonly completed: number;
}

/** Public configuration of {@link Coordinator}. */
export interface CoordinatorOptions {
  /** Spawner used to create workers. Required: the coordinator wraps it. */
  readonly spawner: SubAgentSpawner;
  /**
   * Optional risk gate. When provided, the coordinator awaits this
   * function for every task before spawning the matching worker. The
   * function receives the task and a list of proposed tools; return
   * `true` to allow, `false` to reject (the worker is then skipped and
   * the result is a synthetic "denied" TaskResult).
   */
  readonly approveRisk?: (task: CoordinateTask) => Promise<boolean> | boolean;
  /** Default `workingDir` for tasks that do not specify one. */
  readonly defaultWorkingDir?: string;
  /** Default `providerId` for tasks that do not specify one. */
  readonly defaultProviderId?: string;
  /** Default `modelId` for tasks that do not specify one. */
  readonly defaultModelId?: string;
  /**
   * Strategy for merging worker outputs. Defaults to {@link defaultMerge}.
   */
  readonly merge?: (results: ReadonlyArray<{ key: string; result: TaskResult }>) => string;
}

/** Public configuration for {@link Coordinator.coordinate}. */
export interface CoordinateOptions {
  /** Mode inherited from the parent (forwarded to every worker). */
  readonly mode?: 'plan' | 'auto' | 'full' | 'read-only';
  /** Maximum time to wait for the whole batch, in ms. */
  readonly timeoutMs?: number;
}

/**
 * Run a batch of sub-tasks and aggregate the results. The coordinator
 * holds no per-task state of its own: it just delegates to a
 * {@link SubAgentSpawner} and stitches the outputs together.
 */
export class Coordinator {
  private readonly spawner: SubAgentSpawner;
  private readonly approveRisk: ((task: CoordinateTask) => Promise<boolean> | boolean) | null;
  private readonly defaultWorkingDir: string | undefined;
  private readonly defaultProviderId: string | undefined;
  private readonly defaultModelId: string | undefined;
  private readonly merge: (results: ReadonlyArray<{ key: string; result: TaskResult }>) => string;

  constructor(options: CoordinatorOptions) {
    this.spawner = options.spawner;
    this.approveRisk = options.approveRisk ?? null;
    this.defaultWorkingDir = options.defaultWorkingDir;
    this.defaultProviderId = options.defaultProviderId;
    this.defaultModelId = options.defaultModelId;
    this.merge = options.merge ?? defaultMerge;
  }

  /**
   * Spawn every task (subject to {@link CoordinatorOptions.approveRisk})
   * and wait for them to finish. Throws when `timeoutMs` is provided and
   * exceeded; the handles are still aborted on timeout.
   */
  async coordinate(
    tasks: readonly CoordinateTask[],
    options: CoordinateOptions = {},
  ): Promise<CoordinationResult> {
    if (tasks.length === 0) {
      return { summary: '(no tasks)', perTask: {}, filesModified: [], totalTokens: 0, errors: 0, completed: 0 };
    }
    const handles: Array<{ key: string; handle: SubAgentHandle }> = [];
    for (const task of tasks) {
      if (this.approveRisk !== null) {
        let allowed: boolean;
        try {
          allowed = await this.approveRisk(task);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn('coordinator: risk gate threw, defaulting to deny', { key: task.key, error: message });
          allowed = false;
        }
        if (!allowed) {
          handles.push({ key: task.key, handle: this.syntheticDenied(task) });
          continue;
        }
      }
      const spawnOptions = this.buildSpawnOptions(task, options.mode);
      const handle = this.spawner.spawn(spawnOptions);
      handles.push({ key: task.key, handle });
    }

    const perTask: Record<string, TaskResult> = {};
    const filesModified = new Set<string>();
    let totalTokens = 0;
    let errors = 0;
    let completed = 0;

    const waitAll = Promise.all(
      handles.map(async ({ key, handle }) => {
        let result: TaskResult;
        try {
          result = await handle.wait();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result = {
            workerId: handle.id,
            summary: `(error) ${message}`,
            finalMessage: '',
            filesModified: [],
            totalTokens: 0,
            durationMs: 0,
            endReason: 'error',
            errorMessage: message,
          };
        }
        perTask[key] = result;
        for (const file of result.filesModified) filesModified.add(file);
        totalTokens += result.totalTokens;
        if (result.endReason === 'error') errors += 1;
        if (result.endReason === 'completed') completed += 1;
        return { key, result };
      }),
    );

    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          for (const { handle } of handles) handle.abort();
          reject(new Error(`coordination timed out after ${String(options.timeoutMs)} ms`));
        }, options.timeoutMs);
      });
      try {
        await Promise.race([waitAll, timeoutPromise]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } else {
      await waitAll;
    }

    const merged = this.merge(handles.map((h) => ({ key: h.key, result: perTask[h.key] as TaskResult })));
    return {
      summary: merged,
      perTask,
      filesModified: Array.from(filesModified),
      totalTokens,
      errors,
      completed,
    };
  }

  /** Forwarded from the underlying spawner. */
  listActive(): readonly SubAgentHandle[] {
    return this.spawner.list();
  }

  private buildSpawnOptions(task: CoordinateTask, mode?: CoordinateOptions['mode']): SpawnOptions {
    const workingDir = task.workingDir ?? this.defaultWorkingDir ?? process.cwd();
    const providerId = task.providerId ?? this.defaultProviderId ?? 'anthropic';
    const modelId = task.modelId ?? this.defaultModelId ?? 'claude-sonnet-4-6';
    const base: SpawnOptions = {
      task: task.task,
      workingDir,
      providerId,
      modelId,
      id: `coord-${task.key}`,
    };
    if (mode !== undefined) {
      (base as { mode?: typeof mode }).mode = mode;
    }
    if (task.tools !== undefined) {
      (base as { tools?: readonly string[] }).tools = task.tools;
    }
    if (task.maxTurns !== undefined) {
      (base as { maxTurns?: number }).maxTurns = task.maxTurns;
    }
    if (task.timeoutMs !== undefined) {
      (base as { timeoutMs?: number }).timeoutMs = task.timeoutMs;
    }
    return base;
  }

  /** Build a synthetic "denied" handle without actually spawning a worker. */
  private syntheticDenied(task: CoordinateTask): SubAgentHandle {
    const id = `denied-${task.key}`;
    const now = Date.now();
    const result: TaskResult = {
      workerId: id,
      summary: '(denied by risk gate)',
      finalMessage: '',
      filesModified: [],
      totalTokens: 0,
      durationMs: 0,
      endReason: 'interrupted',
    };
    let resolver!: (r: TaskResult) => void;
    const waitPromise = new Promise<TaskResult>((resolve) => {
      resolver = resolve;
    });
    resolver(result);
    return {
      id,
      status: 'aborted',
      task: task.task,
      filesModified: [],
      result,
      abort: () => undefined,
      wait: () => waitPromise,
    };
  }
}

/** Default merge: produce a Markdown section per task. */
function defaultMerge(results: ReadonlyArray<{ key: string; result: TaskResult }>): string {
  if (results.length === 0) return '(no results)';
  const out: string[] = [`# Coordination Result (${String(results.length)} task${results.length === 1 ? '' : 's'})`];
  for (const { key, result } of results) {
    out.push('', `## ${key} — ${result.endReason}`);
    out.push(result.finalMessage.length > 0 ? result.finalMessage : '(no output)');
    if (result.filesModified.length > 0) {
      out.push('', 'Files modified:');
      for (const f of result.filesModified) out.push(`- ${f}`);
    }
    if (result.errorMessage !== undefined) {
      out.push('', `Error: ${result.errorMessage}`);
    }
  }
  return out.join('\n');
}

/** Factory that creates a fresh {@link Coordinator}. */
export function createCoordinator(options: CoordinatorOptions): Coordinator {
  return new Coordinator(options);
}

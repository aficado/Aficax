// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\loop\token-budget.ts
// TokenBudgetTracker: per-session accounting for the active model's context
// window. The QueryEngine calls {@link TokenBudgetTracker.update} whenever
// the provider emits a `usage` chunk, and consults {@link
// TokenBudgetTracker.shouldCompact} before each API call to decide whether
// a compaction pass is needed.
//
// The tracker subtracts an `outputReserve` from the raw `contextWindow` so
// that we never spend so much on the prompt that the model has no room to
// generate a reply. The `usableWindow` is `contextWindow - outputReserve`.

import { isNearLimit } from '@aficax/core';

/** Default output reserve (tokens left free for the model's reply). */
export const DEFAULT_OUTPUT_RESERVE = 8_000;

/** Default compaction threshold (fraction of `usableWindow`). */
export const DEFAULT_COMPACTION_THRESHOLD = 0.85;

/** Public configuration of a {@link TokenBudgetTracker}. */
export interface TokenBudgetOptions {
  /** Model's full context window in tokens. */
  readonly contextWindow: number;
  /** Tokens to reserve for the model's output. Defaults to {@link DEFAULT_OUTPUT_RESERVE}. */
  readonly outputReserve?: number;
  /** Compaction threshold (0-1). Defaults to {@link DEFAULT_COMPACTION_THRESHOLD}. */
  readonly compactionThreshold?: number;
}

/**
 * Mutable token-usage tracker. Cheap to construct; the QueryEngine owns one
 * instance per session.
 */
export class TokenBudgetTracker {
  private readonly contextWindow: number;
  private readonly outputReserve: number;
  private readonly compactionThreshold: number;
  private used: number;

  constructor(options: TokenBudgetOptions) {
    if (!Number.isFinite(options.contextWindow) || options.contextWindow <= 0) {
      throw new Error(
        `TokenBudgetTracker: contextWindow must be a positive number (got ${String(options.contextWindow)})`,
      );
    }
    this.contextWindow = Math.floor(options.contextWindow);
    this.outputReserve = Math.max(0, Math.floor(options.outputReserve ?? DEFAULT_OUTPUT_RESERVE));
    this.compactionThreshold = clamp01(options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD);
    this.used = 0;
  }

  /** Total context window as configured. */
  get contextSize(): number {
    return this.contextWindow;
  }

  /** Tokens reserved for the model's output. */
  get reservedOutput(): number {
    return this.outputReserve;
  }

  /** Effective budget available to the prompt + history. */
  get usableWindow(): number {
    return Math.max(0, this.contextWindow - this.outputReserve);
  }

  /** Tokens consumed so far. */
  get tokensUsed(): number {
    return this.used;
  }

  /** Tokens still available before hitting the compaction threshold. */
  get tokensRemaining(): number {
    return Math.max(0, this.usableWindow - this.used);
  }

  /** Fraction of `usableWindow` currently consumed (0-1). */
  get fillRatio(): number {
    if (this.usableWindow <= 0) return 1;
    return this.used / this.usableWindow;
  }

  /** True if usage is at or above `threshold` of `usableWindow`. */
  isNearLimit(threshold: number = this.compactionThreshold): boolean {
    return isNearLimit(this.used, this.usableWindow, threshold);
  }

  /** Convenience: true if `isNearLimit(compactionThreshold)`. */
  shouldCompact(): boolean {
    return this.isNearLimit(this.compactionThreshold);
  }

  /** Add input + output tokens from a single model turn. Negative values are clamped to 0. */
  update(inputTokens: number, outputTokens: number): void {
    const inClean = Math.max(0, Math.floor(safeNumber(inputTokens)));
    const outClean = Math.max(0, Math.floor(safeNumber(outputTokens)));
    this.used += inClean + outClean;
  }

  /** Replace the running counter. Used by the compactor after a successful pass. */
  reset(newUsed: number = 0): void {
    this.used = Math.max(0, Math.floor(safeNumber(newUsed)));
  }

  /** Snapshot for logs / metrics. */
  snapshot(): {
    readonly contextWindow: number;
    readonly outputReserve: number;
    readonly usableWindow: number;
    readonly used: number;
    readonly remaining: number;
    readonly fillRatio: number;
  } {
    return {
      contextWindow: this.contextWindow,
      outputReserve: this.outputReserve,
      usableWindow: this.usableWindow,
      used: this.used,
      remaining: this.tokensRemaining,
      fillRatio: this.fillRatio,
    };
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_COMPACTION_THRESHOLD;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function safeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value;
}

/** Factory that creates a tracker with the given context window. */
export function createTokenBudgetTracker(
  contextWindow: number,
  options: { readonly outputReserve?: number; readonly compactionThreshold?: number } = {},
): TokenBudgetTracker {
  // Build a fresh options object (do not mutate the readonly fields of an
  // existing one) and forward only the keys the caller actually supplied.
  const opts: TokenBudgetOptions = {
    contextWindow,
    ...(options.outputReserve !== undefined ? { outputReserve: options.outputReserve } : {}),
    ...(options.compactionThreshold !== undefined
      ? { compactionThreshold: options.compactionThreshold }
      : {}),
  };
  return new TokenBudgetTracker(opts);
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\loop\compaction.ts
// Three-level context compaction engine.
//
//   micro  — purely local: truncate over-long tool outputs and drop stale
//            tool results from more than N turns ago. No model call.
//   auto   — invoke the model with a structured-summary prompt; replace
//            the entire history with a single system message containing
//            the summary. Has a circuit breaker: after three consecutive
//            failures we set `noAutoCompact = true` and stop trying.
//   full   — same shape as `auto`, but the prompt also inlines the recent
//            files and the active plan. More expensive but recovers the
//            most state. Triggered automatically when `auto` fails to
//            bring the budget below the threshold, or on demand.
//
// The engine is constructed once per session and reused. All methods are
// pure with respect to the input messages: they return a new array and
// never mutate the caller's data.

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import {
  estimateMessagesTokens,
  estimateTokens,
  getLogger,
  type Message,
} from '@aficax/core';

import type { ProviderAdapter } from '../providers/base.js';
import { createToolRegistry, type ToolRegistry } from '../tools/registry.js';

import type { TokenBudgetTracker } from './token-budget.js';

const logger = getLogger();

/** Compaction levels supported by the engine. */
export type CompactionLevel = 'micro' | 'auto' | 'full';

/** Result of a single compaction pass. */
export interface CompactionResult {
  readonly level: CompactionLevel;
  readonly messagesBefore: number;
  readonly messagesAfter: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  /** True when at least one message was actually rewritten or removed. */
  readonly changed: boolean;
  /** When set, the resulting history replaces the prior one. */
  readonly messages?: readonly Message[];
  /** When set, the resulting summary (only for `auto` / `full`). */
  readonly summary?: string;
  /** Set when the pass failed; the engine still returns the best-effort messages. */
  readonly error?: string;
}

/** Context shared by the `auto` and `full` passes. */
export interface CompactionContext {
  /** Provider used to drive the summarisation call. */
  readonly provider: ProviderAdapter;
  /** Token budget — reset to the size of the resulting messages on success. */
  readonly budget: TokenBudgetTracker;
  /** Working directory for the session (used by `full` to read recent files). */
  readonly workingDir: string;
  /** Files accessed in the last 5 turns (used by `full` only). */
  readonly recentFiles?: readonly string[];
  /** Optional active plan from the most recent todo_write. */
  readonly activePlan?: string;
  /** Abort signal propagated from the QueryEngine. */
  readonly signal?: AbortSignal;
}

/** Public configuration for the engine. */
export interface CompactionEngineOptions {
  /** Maximum size (chars) of a tool output before microCompact truncates it. */
  readonly toolOutputTruncateThreshold?: number;
  /** Number of leading chars to keep when truncating a tool output. */
  readonly toolOutputKeepHeadChars?: number;
  /** Drop tool_result messages older than this many turns. */
  readonly toolResultMaxAgeTurns?: number;
  /** Consecutive autoCompact failures before the circuit breaker trips. */
  readonly autoCompactFailureThreshold?: number;
  /** Approximate token target for the autoCompact summary. */
  readonly summaryTargetTokens?: number;
  /** Maximum number of recent files to inline in fullCompact. */
  readonly maxRecentFiles?: number;
  /** Maximum tokens per file inlined by fullCompact. */
  readonly maxTokensPerFile?: number;
  /** Override the host clock (tests). */
  readonly now?: () => number;
}

/** Defaults applied when an option is omitted. */
const DEFAULTS = {
  toolOutputTruncateThreshold: 2_000,
  toolOutputKeepHeadChars: 500,
  toolResultMaxAgeTurns: 10,
  autoCompactFailureThreshold: 3,
  summaryTargetTokens: 3_000,
  maxRecentFiles: 5,
  maxTokensPerFile: 3_000,
} as const;

/** Truncation marker inserted into shortened tool outputs. */
function truncateMarker(omitted: number): string {
  return `... [truncado, ${String(omitted)} caracteres omitidos]`;
}

/** Three-level context compaction. */
export class CompactionEngine {
  private readonly opts: Required<Omit<CompactionEngineOptions, 'now'>> & {
    readonly now: () => number;
  };
  private autoCompactFailures = 0;
  /** When true, the engine refuses to invoke the model for autoCompact. */
  noAutoCompact = false;

  constructor(options: CompactionEngineOptions = {}) {
    this.opts = {
      toolOutputTruncateThreshold: options.toolOutputTruncateThreshold ?? DEFAULTS.toolOutputTruncateThreshold,
      toolOutputKeepHeadChars: options.toolOutputKeepHeadChars ?? DEFAULTS.toolOutputKeepHeadChars,
      toolResultMaxAgeTurns: options.toolResultMaxAgeTurns ?? DEFAULTS.toolResultMaxAgeTurns,
      autoCompactFailureThreshold: options.autoCompactFailureThreshold ?? DEFAULTS.autoCompactFailureThreshold,
      summaryTargetTokens: options.summaryTargetTokens ?? DEFAULTS.summaryTargetTokens,
      maxRecentFiles: options.maxRecentFiles ?? DEFAULTS.maxRecentFiles,
      maxTokensPerFile: options.maxTokensPerFile ?? DEFAULTS.maxTokensPerFile,
      now: options.now ?? Date.now,
    };
  }

  /**
   * MicroCompact: rewrite messages in place to drop old tool results and
   * truncate over-long tool outputs. Never calls the model.
   */
  async microCompact(messages: readonly Message[]): Promise<CompactionResult> {
    const tokensBefore = estimateMessagesTokens(messages);
    const rewrite = this.rewriteMicro(messages);
    const tokensAfter = estimateMessagesTokens(rewrite);
    const changed =
      rewrite.length !== messages.length ||
      rewrite.some((m, i) => messages[i] !== m);
    return {
      level: 'micro',
      messagesBefore: messages.length,
      messagesAfter: rewrite.length,
      tokensBefore,
      tokensAfter,
      changed,
      messages: rewrite,
    };
  }

  /**
   * AutoCompact: ask the model for a structured summary, then replace the
   * entire history with `[summaryMessage]`. After three consecutive
   * failures we set {@link CompactionEngine.noAutoCompact} and future calls
   * become no-ops (they return the input unchanged plus an `error`).
   */
  async autoCompact(
    messages: readonly Message[],
    ctx: CompactionContext,
  ): Promise<CompactionResult> {
    const tokensBefore = estimateMessagesTokens(messages);
    const base: CompactionResult = {
      level: 'auto',
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      tokensBefore,
      tokensAfter: tokensBefore,
      changed: false,
    };
    if (this.noAutoCompact) {
      return { ...base, error: 'autoCompact disabled by circuit breaker' };
    }

    const prompt = this.buildAutoPrompt(messages);
    let summary: string;
    try {
      summary = await this.invokeSummaryModel(prompt, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.autoCompactFailures += 1;
      logger.warn('autoCompact failed', {
        attempt: this.autoCompactFailures,
        error: message,
      });
      if (this.autoCompactFailures >= this.opts.autoCompactFailureThreshold) {
        this.noAutoCompact = true;
        logger.error('autoCompact circuit breaker tripped', {
          failures: this.autoCompactFailures,
        });
      }
      return { ...base, error: message };
    }

    // Reset the breaker on a clean call.
    this.autoCompactFailures = 0;

    const summaryMessage: Message = {
      id: makeMessageId('summary'),
      role: 'system',
      content: { kind: 'text', text: summary },
      timestamp: this.opts.now(),
      tokenCount: estimateTokens(summary),
    };
    const replacement = buildReplacement(messages, summaryMessage);
    const replacementTokens = estimateMessagesTokens(replacement);
    ctx.budget.reset(replacementTokens);
    return {
      level: 'auto',
      messagesBefore: messages.length,
      messagesAfter: replacement.length,
      tokensBefore,
      tokensAfter: replacementTokens,
      changed: true,
      messages: replacement,
      summary,
    };
  }

  /**
   * FullCompact: same shape as `autoCompact` but the prompt includes the
   * recent files (last 5 turns) and the active plan. Use as a last resort
   * when `auto` could not bring the budget below the threshold.
   */
  async fullCompact(
    messages: readonly Message[],
    ctx: CompactionContext,
  ): Promise<CompactionResult> {
    const tokensBefore = estimateMessagesTokens(messages);
    const base: CompactionResult = {
      level: 'full',
      messagesBefore: messages.length,
      messagesAfter: messages.length,
      tokensBefore,
      tokensAfter: tokensBefore,
      changed: false,
    };
    const recentFiles = await this.loadRecentFiles(ctx);
    const prompt = this.buildFullPrompt(messages, recentFiles, ctx.activePlan);
    let summary: string;
    try {
      summary = await this.invokeSummaryModel(prompt, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('fullCompact failed', { error: message });
      return { ...base, error: message };
    }

    const summaryMessage: Message = {
      id: makeMessageId('summary'),
      role: 'system',
      content: { kind: 'text', text: summary },
      timestamp: this.opts.now(),
      tokenCount: estimateTokens(summary),
    };
    const replacement = buildReplacement(messages, summaryMessage);
    const replacementTokens = estimateMessagesTokens(replacement);
    ctx.budget.reset(replacementTokens);
    return {
      level: 'full',
      messagesBefore: messages.length,
      messagesAfter: replacement.length,
      tokensBefore,
      tokensAfter: replacementTokens,
      changed: true,
      messages: replacement,
      summary,
    };
  }

  /** Convenience: run the three levels in cascade until the budget fits. */
  async compactCascade(
    messages: readonly Message[],
    ctx: CompactionContext,
  ): Promise<{
    readonly messages: readonly Message[];
    readonly results: readonly CompactionResult[];
    readonly clearedBudget: boolean;
  }> {
    const results: CompactionResult[] = [];
    let current: readonly Message[] = messages;

    // 1. micro — always safe, never calls the model.
    const micro = await this.microCompact(current);
    results.push(micro);
    if (micro.messages !== undefined) {
      current = micro.messages;
      ctx.budget.reset(estimateMessagesTokens(current));
    }
    if (!this.budgetStillHigh(ctx.budget)) {
      return { messages: current, results, clearedBudget: micro.changed };
    }

    // 2. auto — model call, may fail.
    if (!this.noAutoCompact) {
      const auto = await this.autoCompact(current, ctx);
      results.push(auto);
      if (auto.messages !== undefined) {
        current = auto.messages;
      }
      if (!this.budgetStillHigh(ctx.budget)) {
        return { messages: current, results, clearedBudget: true };
      }
    }

    // 3. full — last resort.
    const full = await this.fullCompact(current, ctx);
    results.push(full);
    if (full.messages !== undefined) {
      current = full.messages;
    }
    const clearedBudget = !this.budgetStillHigh(ctx.budget);
    return { messages: current, results, clearedBudget };
  }

  // -- MicroCompact rewriting --------------------------------------------

  /**
   * Truncate tool outputs above `toolOutputTruncateThreshold` chars and
   * drop tool_result messages that are older than `toolResultMaxAgeTurns`
   * turns. A "turn" is one user message plus everything up to the next
   * user message.
   */
  private rewriteMicro(messages: readonly Message[]): Message[] {
    const turnBoundary = findTurnBoundaries(messages, this.opts.toolResultMaxAgeTurns);
    const out: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m === undefined) continue;
      if (turnBoundary.drop.has(i)) continue;
      out.push(this.truncateIfNeeded(m));
    }
    return out;
  }

  private truncateIfNeeded(message: Message): Message {
    const content = message.content;
    if (content.kind !== 'tool_result') return message;
    const text = content.content;
    if (text.length <= this.opts.toolOutputTruncateThreshold) return message;
    const headChars = this.opts.toolOutputKeepHeadChars;
    const head = text.slice(0, headChars);
    const omitted = text.length - headChars;
    const truncated = `${head}\n\n${truncateMarker(omitted)}`;
    // `Message` declares `tokenCount` as `readonly`, so we cannot assign to
    // it in place. Build a new object that includes the recomputed count
    // when the original message had one.
    const base: Message = {
      ...message,
      content: { ...content, content: truncated },
    };
    if (message.tokenCount !== undefined) {
      return { ...base, tokenCount: estimateTokens(truncated) };
    }
    return base;
  }

  // -- Prompt construction -----------------------------------------------

  /** Build the autoCompact summary prompt (no file inlining). */
  private buildAutoPrompt(messages: readonly Message[]): string {
    const transcript = messagesToTranscript(messages);
    const target = String(this.opts.summaryTargetTokens);
    return [
      'You are summarizing a long conversation between Aficax (an AI software-engineering agent) and a user.',
      'Produce a STRUCTURED summary in Markdown with these sections:',
      '',
      '## Tarea original',
      '(what the user originally asked for; verbatim when short, paraphrased when long)',
      '',
      '## Acciones tomadas',
      '(bullet list, one per turn or tool call; include file paths and tool names)',
      '',
      '## Archivos modificados',
      '(list of file paths touched, with a one-line description of the change for each)',
      '',
      '## Estado actual',
      '(what is left to do; blockers; partial work; failures)',
      '',
      '## Próximos pasos pendientes',
      '(concrete next actions the agent should take to finish the task)',
      '',
      `Target length: <= ${target} tokens. Be concise but complete; do not omit actions or files.`,
      '',
      '--- CONVERSATION ---',
      transcript,
    ].join('\n');
  }

  /** Build the fullCompact summary prompt (with recent files + plan). */
  private buildFullPrompt(
    messages: readonly Message[],
    recentFiles: readonly { readonly path: string; readonly content: string }[],
    activePlan: string | undefined,
  ): string {
    const transcript = messagesToTranscript(messages);
    const fileSection =
      recentFiles.length === 0
        ? '(no recent files)'
        : recentFiles
            .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
            .join('\n\n');
    const planSection = activePlan ?? '(no active plan)';
    const target = String(this.opts.summaryTargetTokens * 2);
    return [
      'You are summarizing a long conversation. Below are the transcript, the recent files, and the active plan.',
      'Produce a STRUCTURED summary in Markdown with these sections:',
      '',
      '## Tarea original',
      '## Acciones tomadas',
      '## Archivos modificados',
      '## Estado actual',
      '## Próximos pasos pendientes',
      '',
      `Target length: <= ${target} tokens. Reference the file contents and the active plan in the relevant sections.`,
      '',
      '--- CONVERSATION ---',
      transcript,
      '',
      '--- RECENT FILES (last 5 turns) ---',
      fileSection,
      '',
      '--- ACTIVE PLAN (from last todo_write) ---',
      planSection,
    ].join('\n');
  }

  /** Read up to `maxRecentFiles` files (capped at `maxTokensPerFile` chars). */
  private async loadRecentFiles(
    ctx: CompactionContext,
  ): Promise<{ readonly path: string; readonly content: string }[]> {
    const files = ctx.recentFiles ?? [];
    if (files.length === 0) return [];
    const out: { path: string; content: string }[] = [];
    const maxChars = this.opts.maxTokensPerFile * 4;
    for (const relOrAbs of files.slice(0, this.opts.maxRecentFiles)) {
      const absolute = isAbsolute(relOrAbs) ? relOrAbs : resolve(ctx.workingDir, relOrAbs);
      try {
        const raw = await readFile(absolute, 'utf-8');
        out.push({
          path: absolute,
          content: raw.length > maxChars ? `${raw.slice(0, maxChars)}\n…[truncated]` : raw,
        });
      } catch (err) {
        logger.debug('recent file could not be read', {
          path: absolute,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /**
   * Call the model with the summary prompt and collect the streamed text
   * into a single string. Throws on hard failures (non-recoverable).
   */
  private async invokeSummaryModel(
    prompt: string,
    ctx: CompactionContext,
  ): Promise<string> {
    const messages = [
      {
        role: 'user' as const,
        content: prompt,
      },
    ];
    const emptyRegistry: ToolRegistry = createToolRegistry();
    const stream = ctx.provider.streamText(messages, emptyRegistry, '', {
      ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      maxTokens: Math.min(this.opts.summaryTargetTokens * 2, 4_000),
    });
    let summary = '';
    for await (const chunk of stream) {
      if (ctx.signal?.aborted === true) {
        throw new Error('aborted');
      }
      if (chunk.type === 'text') {
        summary += chunk.text;
      } else if (chunk.type === 'error') {
        throw chunk.error;
      }
    }
    const trimmed = summary.trim();
    if (trimmed.length === 0) {
      throw new Error('summary model returned an empty response');
    }
    return trimmed;
  }

  private budgetStillHigh(budget: TokenBudgetTracker): boolean {
    return budget.shouldCompact();
  }
}

// -- Helpers --------------------------------------------------------------

/** Identify tool_result messages that are older than `maxAgeTurns` turns. */
function findTurnBoundaries(
  messages: readonly Message[],
  maxAgeTurns: number,
): { readonly drop: ReadonlySet<number> } {
  const drop = new Set<number>();
  if (messages.length === 0 || maxAgeTurns <= 0) return { drop };

  // Compute turn index per message. A turn starts at every user message.
  const turnIndex: number[] = [];
  let turn = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user' && i > 0) turn += 1;
    turnIndex[i] = turn;
  }
  const latestTurn = turn;
  const cutoffTurn = latestTurn - maxAgeTurns;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role !== 'tool_result') continue;
    if ((turnIndex[i] ?? 0) <= cutoffTurn) {
      drop.add(i);
    }
  }
  return { drop };
}

/** Render a `Message[]` as a readable transcript for the summary prompt. */
function messagesToTranscript(messages: readonly Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    lines.push(formatOneMessage(m));
  }
  return lines.join('\n');
}

function formatOneMessage(m: Message): string {
  const header = `[${String(m.role)}]`;
  switch (m.content.kind) {
    case 'text':
      return `${header} ${m.content.text}`;
    case 'tool_use':
      return `${header} tool_use(${m.content.toolName}): ${JSON.stringify(m.content.input)}`;
    case 'tool_result':
      return `${header} tool_result(${m.content.toolName}${m.content.isError ? ', ERROR' : ''}): ${m.content.content}`;
  }
}

function makeMessageId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * Build the replacement message list after a compaction pass. The summary
 * goes first, followed by the most recent user message (when there is one)
 * so the model still has the active prompt to work against.
 */
function buildReplacement(messages: readonly Message[], summary: Message): Message[] {
  const out: Message[] = [summary];
  // Walk backwards looking for the last `user` message — that is the
  // active request from the user which we want to preserve verbatim.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    if (m.role === 'user') {
      out.push(m);
      break;
    }
  }
  return out;
}

/** Factory that creates a fresh {@link CompactionEngine}. */
export function createCompactionEngine(
  options?: CompactionEngineOptions,
): CompactionEngine {
  return new CompactionEngine(options);
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\memory\extractor.ts
// AutoMemoryExtractor: end-of-session analysis of a transcript.
//
// The extractor is invoked when a session ends. It summarises the
// transcript into <= 5 short bullets ("aprendizajes") and commits them to
// the project AFICAX.md under a `## Auto-memory (<date>)` section. Bullets
// that are too similar to an existing entry are dropped so the file does
// not grow without bound.

import { getLogger } from '@aficax/core';

import type { ProviderAdapter } from '../providers/base.js';
import { createToolRegistry, type ToolRegistry } from '../tools/registry.js';

import { MemoryStore } from './store.js';

const logger = getLogger();

/** A single learning extracted from a session. */
export interface AutoMemoryLearning {
  /** One-line bullet (markdown). */
  readonly bullet: string;
  /** Optional category that influences the section title. */
  readonly category: AutoMemoryCategory;
}

export type AutoMemoryCategory =
  | 'files'
  | 'commands'
  | 'errors'
  | 'preferences'
  | 'general';

/** What the extractor needs to know about a session. */
export interface ExtractorSession {
  /** Absolute path of the project's AFICAX.md. */
  readonly aficaxMdPath: string;
  /** Working directory the session ran in. */
  readonly cwd: string;
  /**
   * The transcript or a high-level summary of it. The extractor tolerates
   * either a structured tool-call log or a plain Markdown transcript.
   */
  readonly transcript: string;
  /** Tool calls executed during the session. */
  readonly toolCalls?: readonly ExtractorToolCall[];
  /** Files touched during the session (absolute or repo-relative paths). */
  readonly filesTouched?: readonly string[];
  /** Errors observed during the session (denials, crashes, etc.). */
  readonly errors?: readonly string[];
  /** Bash commands invoked during the session. */
  readonly commands?: readonly string[];
}

export interface ExtractorToolCall {
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly status: 'done' | 'error' | 'denied';
  readonly errorMessage?: string;
}

/** Outcome of a {@link AutoMemoryExtractor.commit} call. */
export interface CommitResult {
  /** Number of bullets written. */
  readonly written: number;
  /** Number of bullets dropped by deduplication. */
  readonly deduplicated: number;
  /** Absolute path of the AFICAX.md that was updated. */
  readonly path: string;
  /** Section title used for this run. */
  readonly sectionTitle: string;
  /** True when a new section was created (false when appended to existing). */
  readonly createdSection: boolean;
}

/** Public configuration of {@link AutoMemoryExtractor}. */
export interface AutoMemoryExtractorOptions {
  /** Provider used to drive the summarisation call. */
  readonly provider: ProviderAdapter;
  /** Optional override of the store (tests). */
  readonly store?: MemoryStore;
  /**
   * Optional override of the model invocation. Tests inject a fake
   * provider; production callers leave this unset.
   */
  readonly invokeModel?: (prompt: string) => Promise<string>;
  /** Maximum number of bullets to extract per session. Defaults to 5. */
  readonly maxLearnings?: number;
  /** Maximum words per bullet. Defaults to 20. */
  readonly maxWordsPerBullet?: number;
  /**
   * Similarity threshold for deduplication (0-1). Defaults to 0.7. A
   * new bullet whose Jaccard similarity with any existing bullet exceeds
   * the threshold is dropped.
   */
  readonly dedupThreshold?: number;
  /** Override the clock (tests). */
  readonly now?: () => Date;
}

const DEFAULT_MAX_LEARNINGS = 5;
const DEFAULT_MAX_WORDS = 20;
const DEFAULT_DEDUP_THRESHOLD = 0.7;

/**
 * Extracts learnings at the end of a session and commits them to the
 * project AFICAX.md. Stateless apart from its collaborators, so the same
 * instance can serve every session that the server handles.
 */
export class AutoMemoryExtractor {
  private readonly provider: ProviderAdapter;
  private readonly store: MemoryStore;
  private readonly invokeModel: (prompt: string) => Promise<string>;
  private readonly maxLearnings: number;
  private readonly maxWordsPerBullet: number;
  private readonly dedupThreshold: number;
  private readonly now: () => Date;

  constructor(options: AutoMemoryExtractorOptions) {
    this.provider = options.provider;
    this.store = options.store ?? new MemoryStore();
    this.invokeModel = options.invokeModel ?? ((p) => this.defaultInvoke(p));
    this.maxLearnings = options.maxLearnings ?? DEFAULT_MAX_LEARNINGS;
    this.maxWordsPerBullet = options.maxWordsPerBullet ?? DEFAULT_MAX_WORDS;
    this.dedupThreshold = options.dedupThreshold ?? DEFAULT_DEDUP_THRESHOLD;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Extract up to {@link AutoMemoryExtractorOptions.maxLearnings} bullets
   * from `session` and append them to the project's AFICAX.md under
   * `## Auto-memory (<date>)`. Existing bullets that look similar to a new
   * one are dropped to keep the section compact.
   */
  async commit(session: ExtractorSession): Promise<CommitResult> {
    const existing = await this.store.readAficaxMd(session.aficaxMdPath);
    const existingBullets = extractExistingBullets(existing.content);

    const extracted = await this.extract(session);
    const fresh = deduplicate(extracted, existingBullets, this.dedupThreshold);

    const sectionTitle = `Auto-memory (${this.formatDate(this.now())})`;
    const body = fresh.length === 0
      ? '_No new learnings this session._\n'
      : fresh.map((b) => `- ${b.bullet}`).join('\n') + '\n';
    const createdSection = await this.store.appendToSection(
      session.aficaxMdPath,
      sectionTitle,
      body,
    );

    logger.info('auto-memory committed', {
      path: session.aficaxMdPath,
      written: fresh.length,
      deduplicated: extracted.length - fresh.length,
    });

    return {
      written: fresh.length,
      deduplicated: extracted.length - fresh.length,
      path: session.aficaxMdPath,
      sectionTitle,
      createdSection,
    };
  }

  /**
   * Run the extraction model on a session and parse the response into a
   * list of {@link AutoMemoryLearning} entries. Exposed for callers that
   * want to inspect the raw output (e.g. the `/memory/extract` route).
   */
  async extract(session: ExtractorSession): Promise<AutoMemoryLearning[]> {
    const prompt = this.buildPrompt(session);
    const raw = await this.invokeModel(prompt);
    return parseLearnings(raw, {
      maxLearnings: this.maxLearnings,
      maxWordsPerBullet: this.maxWordsPerBullet,
    });
  }

  // -- Internals ---------------------------------------------------------

  /** Build the prompt sent to the model. */
  private buildPrompt(session: ExtractorSession): string {
    const lines: string[] = [
      'You are reviewing a single coding session of an AI software-engineering agent called Aficax.',
      `Your job is to extract up to ${String(this.maxLearnings)} concise learnings about THIS project or the user\'s preferences.`,
      '',
      'For each learning, output ONE Markdown bullet. Rules:',
      `- Maximum ${String(this.maxWordsPerBullet)} words per bullet.`,
      '- Start every bullet with a category label in square brackets, e.g. `[files]`, `[commands]`, `[errors]`, `[preferences]`, `[general]`.',
      '- Be specific: name file paths, command names, error patterns, and concrete style choices.',
      '- Skip generic platitudes ("be careful", "test thoroughly"). Skip ephemeral state ("ran test X today").',
      '- If the session has nothing worth remembering, output the single bullet: `[general] No durable learnings this session.`.',
      '',
      '## Context',
      `Working directory: ${session.cwd}`,
    ];
    if (session.filesTouched !== undefined && session.filesTouched.length > 0) {
      lines.push('', '### Files touched');
      for (const f of session.filesTouched.slice(0, 20)) lines.push(`- ${f}`);
    }
    if (session.commands !== undefined && session.commands.length > 0) {
      lines.push('', '### Bash commands');
      for (const c of session.commands.slice(0, 20)) lines.push(`- ${c}`);
    }
    if (session.errors !== undefined && session.errors.length > 0) {
      lines.push('', '### Errors observed');
      for (const e of session.errors.slice(0, 20)) lines.push(`- ${e}`);
    }
    if (session.toolCalls !== undefined && session.toolCalls.length > 0) {
      lines.push('', '### Tool calls (last 20)');
      for (const tc of session.toolCalls.slice(-20)) {
        const tail = tc.errorMessage !== undefined ? ` — error: ${tc.errorMessage}` : '';
        lines.push(`- ${tc.toolName} (${tc.status})${tail}`);
      }
    }
    lines.push('', '## Transcript', '', session.transcript);
    lines.push('', '## Output');
    lines.push('Return ONLY the bullet list. No preamble, no closing summary.');
    return lines.join('\n');
  }

  /** Default model invocation: stream text via the provider adapter. */
  private async defaultInvoke(prompt: string): Promise<string> {
    const messages = [{ role: 'user' as const, content: prompt }];
    const emptyRegistry: ToolRegistry = createToolRegistry();
    const stream = this.provider.streamText(messages, emptyRegistry, '', {
      maxTokens: 600,
    });
    let text = '';
    for await (const chunk of stream) {
      if (chunk.type === 'text') {
        text += chunk.text;
      } else if (chunk.type === 'error') {
        throw chunk.error;
      }
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      throw new Error('auto-memory model returned an empty response');
    }
    return trimmed;
  }

  /** Format the section date as `YYYY-MM-DD HH:MM`. */
  private formatDate(date: Date): string {
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
}

// -- Helpers --------------------------------------------------------------

/**
 * Pull existing bullet lines from an AFICAX.md body. Only the lines that
 * start with `-` or `*` and are not part of a fenced code block are
 * considered. The section header text is also returned so callers can
 * identify "Auto-memory" sections to scope the dedup.
 */
function extractExistingBullets(markdown: string): string[] {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      out.push(trimmed.slice(2).trim());
    }
  }
  return out;
}

function parseLearnings(
  raw: string,
  limits: { readonly maxLearnings: number; readonly maxWordsPerBullet: number },
): AutoMemoryLearning[] {
  const lines = raw.split('\n');
  const out: AutoMemoryLearning[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!trimmed.startsWith('-') && !trimmed.startsWith('*') && !/^\[[\w-]+\]/.test(trimmed)) {
      continue;
    }
    let body = trimmed.replace(/^[-*]\s+/, '');
    const category = parseCategory(body) ?? 'general';
    body = body.replace(/^\[[\w-]+\]\s*/, '').trim();
    if (body.length === 0) continue;
    body = truncateWords(body, limits.maxWordsPerBullet);
    out.push({ bullet: body, category });
    if (out.length >= limits.maxLearnings) break;
  }
  return out;
}

function parseCategory(bullet: string): AutoMemoryCategory | null {
  const m = /^\[(\w[\w-]*)\]/.exec(bullet);
  if (m === null) return null;
  const raw = (m[1] ?? '').toLowerCase();
  if (raw === 'files' || raw === 'commands' || raw === 'errors' || raw === 'preferences' || raw === 'general') {
    return raw;
  }
  return 'general';
}

function truncateWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ');
}

/**
 * Drop any new bullet whose Jaccard similarity with an existing bullet
 * exceeds `threshold`. Comparison runs on the lowercased word set; the
 * order of words is ignored. Returns the new bullets that survived.
 */
function deduplicate(
  fresh: readonly AutoMemoryLearning[],
  existing: readonly string[],
  threshold: number,
): AutoMemoryLearning[] {
  if (existing.length === 0) return [...fresh];
  const existingSets = existing.map(tokenise);
  const out: AutoMemoryLearning[] = [];
  for (const learning of fresh) {
    const candidate = tokenise(learning.bullet);
    let duplicate = false;
    for (const set of existingSets) {
      if (jaccard(candidate, set) >= threshold) {
        duplicate = true;
        break;
      }
    }
    if (!duplicate) out.push(learning);
  }
  return out;
}

function tokenise(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w.length > 0));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Factory that creates a fresh {@link AutoMemoryExtractor}. */
export function createAutoMemoryExtractor(
  options: AutoMemoryExtractorOptions,
): AutoMemoryExtractor {
  return new AutoMemoryExtractor(options);
}

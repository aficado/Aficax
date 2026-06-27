// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\repo-map.ts
// RepoMap: a compact, model-friendly summary of the repository.
//
// The map is a one-line-per-file digest: file path, followed by the
// symbols (functions, classes, exports, ...) the parser extracted. The
// whole text is capped to ~4000 tokens so it can be injected into the
// system prompt without dominating the budget.
//
// Build pipeline
// --------------
//   1. Walk the repo with the {@link IgnoreHandler} skipping dotfiles,
//      dependency caches, and the project's `.gitignore`.
//   2. For every source file the {@link SymbolParser} recognises,
//      extract a {@link FileSymbols} payload.
//   3. Render the symbols in a fixed format, trimming the longest lines
//      first when the token cap is exceeded.

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { estimateTokens, getLogger } from '@aficax/core';

import { FileCache, createFileCache } from './file-cache.js';
import { createIgnoreHandler, type IgnoreHandler } from './ignore.js';
import { type FileSymbols, createSymbolParser, type SymbolParser } from './tree-sitter.js';

const logger = getLogger();

/** Hard upper bound on the rendered text. */
const DEFAULT_MAX_TOKENS = 4_000;
/** Max number of source files visited per build. */
const DEFAULT_MAX_FILES = 5_000;
/** Approximate chars per line of the rendered text. */
const PREVIEW_CHARS = 120;

/** One line of the rendered repo-map. */
export interface RepoMapLine {
  /** File path relative to the repo root. */
  readonly file: string;
  /** Symbols the parser extracted, in declaration order. */
  readonly symbols: readonly string[];
}

/** Public configuration of {@link RepoMap}. */
export interface RepoMapOptions {
  /** Absolute path to the repo root. */
  readonly cwd: string;
  /** Override the ignore handler. */
  readonly ignore?: IgnoreHandler;
  /** Override the symbol parser. */
  readonly parser?: SymbolParser;
  /** Override the file cache (used by the parser). */
  readonly cache?: FileCache;
  /** Token cap for the rendered text. Default {@link DEFAULT_MAX_TOKENS}. */
  readonly maxTokens?: number;
  /** Maximum number of files visited per build. Default {@link DEFAULT_MAX_FILES}. */
  readonly maxFiles?: number;
  /** Override the IO read (tests). */
  readonly readOverride?: (path: string) => Promise<string | null>;
}

/**
 * Per-file parse result, kept around so {@link RepoMap.update} can
 * invalidate a single file without rebuilding the whole map.
 */
interface ParsedFile {
  readonly path: string;
  readonly relPath: string;
  readonly symbols: readonly string[];
}

/**
 * Compact repository summary. Build once with {@link RepoMap.build};
 * call {@link RepoMap.update} when files change to keep the in-memory
 * state current. The {@link RepoMap.render} method produces the final
 * text the model sees.
 */
export class RepoMap {
  private readonly cwd: string;
  private readonly ignore: IgnoreHandler;
  private readonly parser: SymbolParser;
  private readonly cache: FileCache;
  private readonly maxTokens: number;
  private readonly maxFiles: number;
  private readonly readOverride: ((path: string) => Promise<string | null>) | null;
  private readonly parsed: Map<string, ParsedFile> = new Map();
  private builtAt = 0;
  private fileCount = 0;

  constructor(options: RepoMapOptions) {
    this.cwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
    this.ignore = options.ignore ?? createIgnoreHandler({ cwd: this.cwd });
    this.parser = options.parser ?? createSymbolParser();
    this.cache = options.cache ?? createFileCache();
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.readOverride = options.readOverride ?? null;
  }

  /** Path the map was built for. */
  get root(): string {
    return this.cwd;
  }

  /** Number of files currently represented in the map. */
  get size(): number {
    return this.parsed.size;
  }

  /** Wall-clock time (ms) of the most recent successful build. */
  get lastBuiltAt(): number {
    return this.builtAt;
  }

  /**
   * (Re)build the map from disk. Returns the rendered text so callers
   * can use it as a one-shot. Safe to call concurrently; subsequent
   * calls will wait for the in-flight one.
   */
  async build(): Promise<string> {
    await this.ignore.load();
    this.parsed.clear();
    this.fileCount = 0;
    await this.walk(this.cwd, this.cwd);
    this.builtAt = Date.now();
    return this.render();
  }

  /**
   * Update the map after a set of files has changed. Each entry is
   * either re-parsed (when the file exists) or removed from the map
   * (when the file is gone). Returns the rendered text.
   */
  async update(changedFiles: readonly string[]): Promise<string> {
    for (const relOrAbs of changedFiles) {
      const absolute = isAbsolute(relOrAbs) ? relOrAbs : resolve(this.cwd, relOrAbs);
      const rel = relative(this.cwd, absolute);
      if (rel.startsWith('..')) continue;
      let info;
      try {
        info = await stat(absolute);
      } catch {
        this.parsed.delete(absolute);
        this.cache.invalidate(absolute);
        continue;
      }
      if (!info.isFile()) {
        this.parsed.delete(absolute);
        continue;
      }
      const symbols = await this.parseFile(absolute);
      if (symbols === null) {
        this.parsed.delete(absolute);
        continue;
      }
      this.parsed.set(absolute, { path: absolute, relPath: rel, symbols });
    }
    return this.render();
  }

  /** Render the current map. Trim longest lines first when over budget. */
  render(): string {
    const lines: RepoMapLine[] = Array.from(this.parsed.values())
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((p) => ({ file: p.relPath, symbols: p.symbols }));
    let text = formatLines(lines);
    let tokens = estimateTokens(text);
    if (tokens <= this.maxTokens) return text;

    // Trim the longest "symbols" list per file first, then drop whole
    // files (those with the most symbols) when even trimming is not
    // enough. We always keep at least one symbol per kept file.
    const sortedByLength = Array.from(this.parsed.values()).sort(
      (a, b) => b.symbols.length - a.symbols.length,
    );
    const keep = new Set<string>(sortedByLength.map((p) => p.path));
    let cursor = sortedByLength.length;
    while (tokens > this.maxTokens && cursor > 0) {
      // Drop one whole file per iteration (the one with the most symbols).
      cursor -= 1;
      const drop = sortedByLength[cursor];
      if (drop === undefined) break;
      keep.delete(drop.path);
      text = formatLines(filterLines(lines, keep));
      tokens = estimateTokens(text);
    }
    // Second pass: trim each remaining file's symbol list.
    if (tokens > this.maxTokens) {
      const limit = Math.max(1, Math.floor((this.maxTokens / Math.max(1, tokens)) * 4));
      const trimmed = new Map<string, string[]>();
      for (const line of lines) {
        if (!keep.has(pathForLine(line))) continue;
        const originalSymbols = this.parsed.get(pathForLine(line))?.symbols ?? [];
        const allowed = Math.max(1, Math.min(originalSymbols.length, limit));
        trimmed.set(pathForLine(line), originalSymbols.slice(0, allowed));
      }
      text = formatLines(
        lines.map((l) => ({
          file: l.file,
          symbols: trimmed.get(pathForLine(l)) ?? l.symbols,
        })),
      );
      tokens = estimateTokens(text);
    }
    return text;
  }

  /** Snapshot of the per-file symbol strings (handy for tests). */
  raw(): readonly RepoMapLine[] {
    return Array.from(this.parsed.values())
      .sort((a, b) => a.relPath.localeCompare(b.relPath))
      .map((p) => ({ file: p.relPath, symbols: p.symbols }));
  }

  /** Force a reload from disk (delegates to {@link RepoMap.build}). */
  async reload(): Promise<string> {
    return this.build();
  }

  // -- Internals ---------------------------------------------------------

  private async walk(root: string, current: string): Promise<void> {
    if (this.fileCount >= this.maxFiles) return;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (this.fileCount >= this.maxFiles) return;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (this.ignore.shouldSkipDirectory(child)) continue;
        await this.walk(root, child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (this.ignore.shouldIgnore(child, false)) continue;
      const parsed = await this.parseFile(child);
      if (parsed === null) continue;
      this.parsed.set(child, { path: child, relPath: relative(root, child), symbols: parsed });
      this.fileCount += 1;
    }
  }

  private async parseFile(absolute: string): Promise<readonly string[] | null> {
    const symbols = await this.parser.parseFile(absolute);
    if (symbols.skipped) return null;
    if (symbols.symbols.length === 0) return null;
    return symbols.symbols.map((s) => `${s.name} (${s.kind})`);
  }
}

function formatLines(lines: readonly RepoMapLine[]): string {
  if (lines.length === 0) return '(empty repository)';
  const out: string[] = ['# Repository Map'];
  for (const line of lines) {
    const rel = line.file.split(sep).join('/');
    if (line.symbols.length === 0) {
      out.push(`${rel}:`);
      continue;
    }
    const joined = line.symbols.join(', ');
    const body = joined.length > PREVIEW_CHARS ? `${joined.slice(0, PREVIEW_CHARS - 1)}…` : joined;
    out.push(`${rel}: ${body}`);
  }
  return out.join('\n');
}

function filterLines(lines: readonly RepoMapLine[], keep: ReadonlySet<string>): RepoMapLine[] {
  return lines.filter((l) => keep.has(pathForLine(l)));
}

function pathForLine(line: RepoMapLine): string {
  // The map stores absolute paths; reconstruct from the relative one.
  return line.file;
}

void relative; // silence "unused" lint while keeping the import for future use

/** Factory that creates a fresh {@link RepoMap}. */
export function createRepoMap(options: RepoMapOptions): RepoMap {
  return new RepoMap(options);
}

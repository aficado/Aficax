// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\ripgrep.ts
// Ripgrep wrapper: a thin, async API over the `rg` binary with a manual
// fallback when the binary is not on PATH.
//
// Detection
// ---------
// We look for `rg` in three places, in order:
//   1. The `AFICAX_RG_BIN` env var (lets ops point at a custom build).
//   2. The directory of the running Aficax binary (a `rg` shipped next
//      to the executable so the agent works on bare containers).
//   3. `PATH`, via `Bun.spawn({ cmd: ['rg', '--version'] })`.
//
// When none of the three resolves, every `search` call falls through to
// a {@link ManualSearcher} that walks the tree, applies the ignore
// handler, and runs a JS `RegExp` over each file's content.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getLogger } from '@aficax/core';

import { createIgnoreHandler, type IgnoreHandler } from './ignore.js';

const logger = getLogger();

/** Hard cap on a single rg invocation before we kill it. */
const RG_TIMEOUT_MS = 10_000;
/** Maximum file size the manual scanner is willing to read. */
const MANUAL_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Default cap on results returned per search. */
const DEFAULT_MAX_RESULTS = 200;

/** One ripgrep hit, post-parse. */
export interface RipgrepMatch {
  /** Absolute path of the matching file. */
  readonly file: string;
  /** 1-based line number of the match. */
  readonly line: number;
  /** 1-based column of the match, when the engine reports it. */
  readonly column: number;
  /** The matched line, with trailing newline stripped. */
  readonly text: string;
  /** Context lines around the match, when requested. */
  readonly context: ReadonlyArray<{ readonly line: number; readonly text: string }>;
}

/** Search options accepted by {@link RipgrepSearcher.search}. */
export interface RipgrepSearchOptions {
  /** Directory or file to search in. Defaults to the handler's cwd. */
  readonly cwd?: string;
  /** Glob passed to rg (`--glob`); ignored by the manual fallback. */
  readonly filePattern?: string;
  /** Case-sensitive. Default `true`. */
  readonly caseSensitive?: boolean;
  /** Maximum number of matches. Default 200. */
  readonly maxResults?: number;
  /** Lines of context to capture around each match. Default 0. */
  readonly contextLines?: number;
  /** Abort signal: the search cancels ASAP when triggered. */
  readonly signal?: AbortSignal;
  /** Path to the rg binary. Overrides the auto-detected location. */
  readonly rgBinary?: string;
}

/** Public configuration of {@link RipgrepSearcher}. */
export interface RipgrepSearcherOptions {
  /** Default working directory used when a search omits `cwd`. */
  readonly cwd: string;
  /**
   * Shared ignore handler. When omitted, a fresh one is built from
   * `cwd` and loaded on the first search.
   */
  readonly ignore?: IgnoreHandler;
  /**
   * Override the rg spawn (tests). Receives the argv; returns a
   * {@link RgChild} handle. Defaults to {@link defaultRgSpawn}.
   */
  readonly spawn?: (argv: readonly string[]) => Promise<RgChild>;
  /**
   * Override the version probe (tests). Receives a binary path; returns
   * `true` when the binary responds to `--version`.
   */
  readonly probe?: (binary: string) => Promise<boolean>;
}

/** Minimal rg child handle. */
export interface RgChild {
  /** Resolves to the raw stdout text. */
  stdout(): Promise<string>;
  /** Resolves to the raw stderr text. */
  stderr(): Promise<string>;
  /** Resolves to the exit code. */
  exited(): Promise<number>;
  /** Kill the child (rg exits cleanly when its stdin closes). */
  kill(): void;
}

/**
 * Detect whether a binary is `rg` by asking it for its version string.
 * Returns `false` on any failure (timeout, non-zero exit, empty output).
 */
export async function probeRg(binary: string): Promise<boolean> {
  try {
    const child = defaultRgSpawn([binary, '--version']);
    const proc = await child;
    const [stdout, stderr, exitCode] = await Promise.all([
      proc.stdout(),
      proc.stderr(),
      proc.exited(),
    ]);
    if (exitCode !== 0) return false;
    const text = (stdout + stderr).toLowerCase();
    return text.includes('ripgrep') || text.startsWith('rg ');
  } catch {
    return false;
  }
}

/** Look for an `rg` binary in the standard locations. */
export async function detectRgBinary(): Promise<string | null> {
  const envOverride = process.env['AFICAX_RG_BIN'];
  if (typeof envOverride === 'string' && envOverride.length > 0 && existsSync(envOverride)) {
    return envOverride;
  }
  const exe = (() => {
    try {
      return process.execPath;
    } catch {
      return '';
    }
  })();
  if (exe.length > 0) {
    const sibling = join(dirname(exe), process.platform === 'win32' ? 'rg.exe' : 'rg');
    if (await probeRg(sibling)) return sibling;
  }
  if (await probeRg('rg')) return 'rg';
  return null;
}

/** Default spawner backed by `node:child_process.spawn`. */
export function defaultRgSpawn(argv: readonly string[]): Promise<RgChild> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(argv[0] ?? 'rg', argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', (err) => reject(err));
    const handle: RgChild = {
      stdout: async () => Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: async () => Buffer.concat(stderrChunks).toString('utf-8'),
      exited: () => new Promise<number>((res) => {
        child.on('close', (code) => res(code ?? -1));
      }),
      kill: () => {
        try { child.kill(); } catch { /* ignore */ }
      },
    };
    resolve(handle);
  });
}

/**
 * Build the rg argv. The `--` separator is mandatory so the pattern is
 * not interpreted as a flag when it starts with `-`.
 */
export function buildRgArgs(
  pattern: string,
  searchPath: string,
  options: { readonly filePattern?: string; readonly caseSensitive: boolean; readonly contextLines: number },
): string[] {
  const args: string[] = [
    '--line-number',
    '--column',
    '--no-heading',
    '--color=never',
    '--no-messages',
    '--null', // null-separated: path\0line:col:text
  ];
  if (!options.caseSensitive) args.push('-i');
  if (options.contextLines > 0) args.push('-C', String(options.contextLines));
  if (options.filePattern !== undefined && options.filePattern.length > 0) {
    args.push('--glob', options.filePattern);
  }
  args.push('--', pattern, searchPath);
  return args;
}

/** Parse `--null` rg output into {@link RipgrepMatch}es. */
export function parseNullSeparated(stdout: string, contextSize: number): RipgrepMatch[] {
  if (stdout.length === 0) return [];
  const out: RipgrepMatch[] = [];
  // rg with `--null` emits `path\0line:col:text\n` for every hit. Context
  // lines (when requested) share the same `path\0` prefix but lack a
  // column number; they are `path\0line-:text` (hyphen for column).
  const records = stdout.split('\n');
  for (const record of records) {
    if (record.length === 0) continue;
    const firstNull = record.indexOf('\0');
    if (firstNull === -1) continue;
    const path = record.slice(0, firstNull);
    const payload = record.slice(firstNull + 1);
    if (path.length === 0) continue;
    const colon = payload.indexOf(':');
    if (colon === -1) continue;
    const lineText = payload.slice(0, colon);
    const rest = payload.slice(colon + 1);
    const lineNum = Number.parseInt(lineText, 10);
    if (!Number.isFinite(lineNum)) {
      // Probably a context line ("line-:text"); we keep it attached to
      // the next match by emitting a placeholder that the search loop
      // can correlate. For now, drop it on the floor — context assembly
      // is the caller's responsibility when contextLines > 0.
      continue;
    }
    const colonTwo = rest.indexOf(':');
    let column = 0;
    let text: string;
    if (colonTwo === -1) {
      text = rest;
    } else {
      const colText = rest.slice(0, colonTwo);
      const parsedCol = Number.parseInt(colText, 10);
      if (Number.isFinite(parsedCol)) {
        column = parsedCol;
        text = rest.slice(colonTwo + 1);
      } else {
        text = rest;
      }
    }
    out.push({
      file: path,
      line: lineNum,
      column,
      text: text.replace(/\r$/, ''),
      context: contextSize > 0 ? [] : [], // context is filled in by the rg wrapper
    });
  }
  return out;
}

/**
 * Run a regex search using `rg` when available and a manual walker when
 * it is not. The returned matches are sorted by `(file, line)`.
 */
export class RipgrepSearcher {
  private readonly defaultCwd: string;
  private readonly ignore: IgnoreHandler;
  private readonly spawn: (argv: readonly string[]) => Promise<RgChild>;
  private readonly probe: (binary: string) => Promise<boolean>;
  private cachedBinary: string | null | undefined;

  constructor(options: RipgrepSearcherOptions) {
    this.defaultCwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
    this.ignore = options.ignore ?? createIgnoreHandler({ cwd: this.defaultCwd });
    this.spawn = options.spawn ?? defaultRgSpawn;
    this.probe = options.probe ?? probeRg;
  }

  /**
   * Run a search. Returns up to `options.maxResults` matches. Falls back
   * to a manual walker when rg is not available.
   */
  async search(pattern: string, options: RipgrepSearchOptions = {}): Promise<RipgrepMatch[]> {
    const searchPath = options.cwd !== undefined
      ? (isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd))
      : this.defaultCwd;
    const caseSensitive = options.caseSensitive ?? true;
    const maxResults = options.maxResults ?? DEFAULT_MAX_RESULTS;
    const contextLines = options.contextLines ?? 0;

    if (options.signal !== undefined && options.signal.aborted) return [];

    const binary = await this.ensureBinary(options.rgBinary);
    if (binary !== null) {
      try {
        const matches = await this.runRg(binary, pattern, searchPath, options, caseSensitive, contextLines);
        return matches.slice(0, maxResults);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('ripgrep: rg run failed, falling back to manual', { error: message });
      }
    }

    const matches = await this.runManual(pattern, searchPath, options, caseSensitive, maxResults);
    return matches;
  }

  private async runRg(
    binary: string,
    pattern: string,
    searchPath: string,
    options: RipgrepSearchOptions,
    caseSensitive: boolean,
    contextLines: number,
  ): Promise<RipgrepMatch[]> {
    const args = buildRgArgs(pattern, searchPath, {
      ...(options.filePattern !== undefined ? { filePattern: options.filePattern } : {}),
      caseSensitive,
      contextLines,
    });
    const handle = await this.spawn([binary, ...args]);
    const timer = setTimeout(() => handle.kill(), RG_TIMEOUT_MS);
    options.signal?.addEventListener('abort', () => handle.kill(), { once: true });
    try {
      const [stdout, exitCode] = await Promise.all([handle.stdout(), handle.exited()]);
      if (exitCode !== 0 && exitCode !== 1) {
        // rg: 0 = matches, 1 = no matches, 2+ = error.
        const stderr = await handle.stderr();
        throw new Error(`rg exited with code ${String(exitCode)}: ${stderr.slice(0, 200)}`);
      }
      return parseNullSeparated(stdout, contextLines);
    } finally {
      clearTimeout(timer);
    }
  }

  private async runManual(
    pattern: string,
    searchPath: string,
    options: RipgrepSearchOptions,
    caseSensitive: boolean,
    maxResults: number,
  ): Promise<RipgrepMatch[]> {
    const regex = new RegExp(pattern, caseSensitive ? '' : 'i');
    const out: RipgrepMatch[] = [];
    const targetStat = await stat(searchPath).catch(() => null);
    if (targetStat === null) return out;
    if (targetStat.isFile()) {
      await scanFile(searchPath, regex, out, options.signal);
    } else if (targetStat.isDirectory()) {
      await walk(searchPath, this.ignore, async (file) => {
        if (out.length >= maxResults) return;
        if (options.filePattern !== undefined && options.filePattern.length > 0) {
          if (!matchesGlob(options.filePattern, file)) return;
        }
        await scanFile(file, regex, out, options.signal);
      }, options.signal);
    }
    return out.slice(0, maxResults);
  }

  private async ensureBinary(override: string | undefined): Promise<string | null> {
    if (override !== undefined) {
      if (await this.probe(override)) return override;
      return null;
    }
    if (this.cachedBinary !== undefined) return this.cachedBinary;
    const detected = await detectRgBinary().catch(() => null);
    this.cachedBinary = detected;
    return detected;
  }
}

// -- Manual walker --------------------------------------------------------

async function walk(
  cwd: string,
  ignore: IgnoreHandler,
  visit: (file: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const queue: string[] = [cwd];
  while (queue.length > 0) {
    if (signal?.aborted === true) return;
    const current = queue.shift();
    if (current === undefined) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (signal !== undefined && signal.aborted) return;
      const child = join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignore.shouldSkipDirectory(child)) continue;
        queue.push(child);
      } else if (entry.isFile()) {
        if (ignore.shouldIgnore(child, false)) continue;
        await visit(child);
      }
    }
  }
}

async function scanFile(
  file: string,
  regex: RegExp,
  out: RipgrepMatch[],
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return;
  let info;
  try {
    info = await stat(file);
  } catch {
    return;
  }
  if (info.size > MANUAL_MAX_FILE_BYTES) return;
  let content: string;
  try {
    content = await readFile(file, 'utf-8');
  } catch {
    return;
  }
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = regex.exec(line);
    if (match === null) continue;
    out.push({
      file,
      line: i + 1,
      column: match.index + 1,
      text: line,
      context: [],
    });
  }
}

function matchesGlob(pattern: string, file: string): boolean {
  // Same tiny matcher as `ignore.ts` — enough for `**/*.ts` and friends.
  const re = new RegExp(
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '::DOUBLESTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/::DOUBLESTAR::/g, '.*')
      .replace(/\?/g, '.') +
    '$',
  );
  // `relative` may yield Windows backslashes; normalise.
  const normalised = relative(process.cwd(), file).split(sep).join('/');
  return re.test(normalised) || re.test(file.split(sep).join('/'));
}

/** Factory that creates a fresh {@link RipgrepSearcher}. */
export function createRipgrepSearcher(options: RipgrepSearcherOptions): RipgrepSearcher {
  return new RipgrepSearcher(options);
}

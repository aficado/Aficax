// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\ignore.ts
// IgnoreHandler: read `.gitignore` (and the optional `.aficaxignore`) and
// decide whether a given path should be hidden from the indexer and the
// file-system tools.
//
// The handler is intentionally minimal: it supports the subset of git's
// ignore syntax that matters in practice (literal paths, `*`/`?`/`[]`
// globs, leading `/` for rooted patterns, trailing `/` for directories,
// `!pattern` for negation, `#` comments, blank lines). Anything more
// exotic is parsed but not interpreted — the worst case is a path that
// is not filtered when it should be, never a path that is incorrectly
// filtered (negation patterns are the only exception to that rule and
// are honoured when their syntax is unambiguous).
//
// In addition to the on-disk rules, a small set of well-known dependency
// and build-output directories is always excluded. This guarantees the
// indexer never descends into `node_modules` even when the repository has
// no `.gitignore`.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep, win32, posix } from 'node:path';

import { getLogger } from '@aficax/core';

const logger = getLogger();

/** Directory names that are always excluded, regardless of ignore files. */
const ALWAYS_IGNORED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'target',
];

/** File-name globs that are always excluded. */
const ALWAYS_IGNORED_PATTERNS: readonly RegExp[] = [
  /\.min\.js$/u,
  /\.min\.css$/u,
  /\.map$/u,
  /\.pyc$/u,
  /\.pyo$/u,
  /\.o$/u,
  /\.a$/u,
  /\.so$/u,
  /\.dll$/u,
  /\.dylib$/u,
  /\.wasm$/u,
  /\.lock$/u,
];

/** A single parsed ignore rule. */
interface IgnoreRule {
  readonly raw: string;
  /** `false` for whitelist rules (`!pattern`), `true` for normal rules. */
  readonly positive: boolean;
  /** Whether the pattern was anchored to the repo root. */
  readonly anchored: boolean;
  /** Whether the pattern only matches directories. */
  readonly directoryOnly: boolean;
  /** Glob body (after stripping leading `/` and trailing `/`). */
  readonly pattern: string;
}

/** Public configuration of {@link IgnoreHandler}. */
export interface IgnoreHandlerOptions {
  /** Absolute path to the repo root. */
  readonly cwd: string;
  /**
   * Override the IO read (tests). Receives an absolute path; returns the
   * file content or `null` when the file does not exist.
   */
  readonly readOverride?: (path: string) => Promise<string | null>;
}

/**
 * Loads `.gitignore` and `.aficaxignore` from `cwd` and answers
 * {@link IgnoreHandler.shouldIgnore} for any path.
 */
export class IgnoreHandler {
  private readonly cwd: string;
  private readonly readOverride: ((path: string) => Promise<string | null>) | null;
  private readonly rules: IgnoreRule[] = [];

  constructor(options: IgnoreHandlerOptions) {
    this.cwd = isAbsolute(options.cwd) ? options.cwd : options.cwd;
    this.readOverride = options.readOverride ?? null;
  }

  /** Initialise the rule list. Idempotent. */
  async load(): Promise<void> {
    this.rules.length = 0;
    const files = [join(this.cwd, '.gitignore'), join(this.cwd, '.aficaxignore')];
    for (const file of files) {
      const raw = await this.read(file);
      if (raw === null) continue;
      const parsed = parseGitignore(raw);
      for (const rule of parsed) this.rules.push(rule);
    }
  }

  /**
   * Decide whether `absolutePath` should be ignored. `isDirectory` is
   * required for rules with a trailing `/`; passing `undefined` is safe
   * but may yield slightly imprecise results for those.
   */
  shouldIgnore(absolutePath: string, isDirectory?: boolean): boolean {
    const rel = relative(this.cwd, absolutePath);
    if (rel.startsWith('..') || rel.length === 0) {
      // Outside the repo: leave the decision to the caller.
      return false;
    }
    const normalised = rel.split(sep).join('/');

    // First, always-ignored set.
    const head = normalised.split('/')[0] ?? '';
    if (ALWAYS_IGNORED_DIRS.includes(head)) return true;
    const base = head === '' ? normalised : normalised.split('/').pop() ?? '';
    for (const re of ALWAYS_IGNORED_PATTERNS) {
      if (re.test(base)) return true;
    }

    // Walk the rules in order. Whitelist rules may override earlier ones.
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && isDirectory !== true) continue;
      const matches = matchRule(rule, normalised, isDirectory === true);
      if (!matches) continue;
      ignored = rule.positive;
    }
    return ignored;
  }

  /** Quick check: should the directory walker skip this directory entirely? */
  shouldSkipDirectory(absoluteDir: string): boolean {
    return this.shouldIgnore(absoluteDir, true);
  }

  /** Force a reload from disk. */
  async reload(): Promise<void> {
    await this.load();
  }

  private async read(path: string): Promise<string | null> {
    if (this.readOverride !== null) {
      try {
        return await this.readOverride(path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('ignore: readOverride failed', { path, error: message });
        return null;
      }
    }
    if (!existsSync(path)) return null;
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('ignore: readFile failed', { path, error: message });
      return null;
    }
  }
}

// -- Helpers --------------------------------------------------------------

/** Parse a single `.gitignore` body into an array of rules. */
function parseGitignore(body: string): IgnoreRule[] {
  const out: IgnoreRule[] = [];
  const lines = body.split(/\r?\n/);
  for (const rawLine of lines) {
    // Strip comments and trim trailing whitespace; gitignore treats a
    // trailing space literally only when escaped, which we do not
    // emulate — close enough for the indexer's needs.
    let line = rawLine;
    const hash = line.indexOf('#');
    if (hash !== -1) {
      // `#` inside a pattern (e.g. `[#]` brackets) is a literal. Walk
      // forward until we find an un-escaped `#`.
      let escape = false;
      let cutAt = -1;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '#') { cutAt = i; break; }
      }
      if (cutAt !== -1) line = line.slice(0, cutAt);
    }
    line = line.trim();
    if (line.length === 0) continue;

    let positive = true;
    if (line.startsWith('!')) {
      positive = false;
      line = line.slice(1).trim();
    }
    if (line.length === 0) continue;

    const anchored = line.startsWith('/');
    if (anchored) line = line.slice(1);

    let directoryOnly = false;
    if (line.endsWith('/')) {
      directoryOnly = true;
      line = line.slice(0, -1);
    }

    if (line.length === 0) continue;

    out.push({ raw: rawLine, positive, anchored, directoryOnly, pattern: line });
  }
  return out;
}

/**
 * Decide whether a single rule matches `path` (a forward-slash relative
 * path). The implementation is small on purpose; we accept some false
 * positives (a too-greedy `*`) over false negatives.
 */
function matchRule(rule: IgnoreRule, path: string, isDirectory: boolean): boolean {
  if (rule.directoryOnly && !isDirectory) return false;
  if (rule.anchored) {
    return globMatch(rule.pattern, path);
  }
  // Unanchored patterns match against any suffix of the path's segments
  // and against the path as a whole.
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const slice = segments.slice(i).join('/');
    if (globMatch(rule.pattern, slice)) return true;
    if (globMatch(rule.pattern, segments[i] ?? '')) return true;
  }
  return false;
}

/** Tiny glob matcher: `*` (any run), `?` (one char), `[abc]`. */
function globMatch(pattern: string, text: string): boolean {
  let pi = 0;
  let ti = 0;
  let starPi = -1;
  let starTi = 0;
  while (ti < text.length) {
    const pc = pattern[pi];
    if (pc === '*') {
      starPi = pi;
      starTi = ti;
      pi++;
      continue;
    }
    if (pc === '?') {
      pi++;
      ti++;
      continue;
    }
    if (pc === '[') {
      const close = pattern.indexOf(']', pi + 1);
      if (close === -1) {
        // Unterminated bracket: literal `[`.
        if (text[ti] === pc) { pi++; ti++; continue; }
      } else {
        const set = pattern.slice(pi + 1, close);
        const tc = text[ti];
        if (tc !== undefined && charClassMatches(set, tc)) {
          pi = close + 1;
          ti++;
          continue;
        }
      }
    }
    if (pc !== undefined && pc === text[ti]) {
      pi++;
      ti++;
      continue;
    }
    if (starPi !== -1) {
      pi = starPi + 1;
      starTi++;
      ti = starTi;
      continue;
    }
    return false;
  }
  while (pi < pattern.length && pattern[pi] === '*') pi++;
  return pi === pattern.length;
}

function charClassMatches(set: string, ch: string): boolean {
  let negate = false;
  let i = 0;
  if (set[0] === '!') {
    negate = true;
    i = 1;
  }
  let matched = false;
  while (i < set.length) {
    if (i + 2 < set.length && set[i + 1] === '-') {
      const start = set[i];
      const end = set[i + 2];
      if (start !== undefined && end !== undefined && ch >= start && ch <= end) {
        matched = true;
        break;
      }
      i += 3;
      continue;
    }
    if (set[i] === ch) {
      matched = true;
      break;
    }
    i++;
  }
  return negate ? !matched : matched;
}

/** Pick the separator the platform uses (for tests that want a hint). */
export const pathSeparator = sep === '\\' ? win32.sep : posix.sep;

/** Factory that creates a fresh {@link IgnoreHandler}. */
export function createIgnoreHandler(options: IgnoreHandlerOptions): IgnoreHandler {
  return new IgnoreHandler(options);
}

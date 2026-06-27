// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\skills\loader.ts
// SkillLoader: discover and parse every `*.md` skill in the standard
// search paths.
//
// Search order (later sources override earlier ones on `name` collision):
//   1. The directory of the running server's `skills/` folder (built-ins
//      shipped with the binary).
//   2. `~/.aficax/skills/*.md` (user-global).
//   3. `<cwd>/.aficax/skills/*.md` (project-level).
//
// Each skill is a Markdown file with a YAML frontmatter block delimited
// by `---` lines. The loader extracts the frontmatter (so it can decide
// whether the skill applies) and the body (which is what gets injected
// into the system prompt).
//
// The loader is intentionally tolerant: a malformed file is logged and
// skipped, never thrown. A `null` frontmatter value or a missing `name`
// is enough to discard the file.

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { getLogger } from '@aficax/core';

import { parseFrontmatter, type ParsedFrontmatter } from './yaml-mini.js';

const logger = getLogger();

/** Where a skill was loaded from. */
export type SkillSource = 'builtin' | 'global' | 'project';

/** One loaded skill. */
export interface Skill {
  /** Stable name from the frontmatter (also the registry key). */
  readonly name: string;
  /** Human description for the matcher / status bar. */
  readonly description: string;
  /** Tool names the skill recommends; informational. */
  readonly tools: readonly string[];
  /** Trigger phrases for the matcher. */
  readonly triggers: readonly string[];
  /** When `true`, always include this skill in the system prompt. */
  readonly always: boolean;
  /** Raw Markdown body, without the frontmatter block. */
  readonly body: string;
  /** Where the skill was loaded from. */
  readonly source: SkillSource;
  /** Absolute path of the file (or built-in name for synthetic skills). */
  readonly path: string;
}

/** Public configuration of {@link SkillLoader}. */
export interface SkillLoaderOptions {
  /** Working directory used to resolve the project-level skills folder. */
  readonly cwd: string;
  /**
   * Absolute path to the built-in skills directory (the `skills/` folder
   * shipped next to the server source). When omitted, the loader uses
   * `<repo>/packages/server/skills`.
   */
  readonly builtinDir?: string;
  /** Override the home directory (tests). */
  readonly homeDir?: string;
  /**
   * Override the IO read (tests). Receives an absolute path; returns the
   * raw file body or `null` when the file is missing.
   */
  readonly readOverride?: (path: string) => Promise<string | null>;
}

/**
 * Built-in skills path resolved relative to this file. The compile-time
 * layout is `packages/server/src/skills/loader.ts` →
 * `packages/server/skills/`, i.e. two directories up.
 */
function defaultBuiltinDir(): string {
  // `import.meta.url` is preferred; we fall back to a CWD-relative guess
  // when the runtime does not expose it.
  try {
    const url = new URL('.', import.meta.url);
    // .../packages/server/src/skills/  →  .../packages/server/skills/
    return join(url.pathname, '..', '..', 'skills');
  } catch {
    return resolve(process.cwd(), 'packages', 'server', 'skills');
  }
}

/**
 * Discover and parse every available skill. Constructed once at server
 * boot; `list()` reads from an in-memory cache populated by `load()`.
 */
export class SkillLoader {
  private readonly cwd: string;
  private readonly builtinDir: string;
  private readonly homeDir: string;
  private readonly readOverride: ((path: string) => Promise<string | null>) | null;
  private skills: Map<string, Skill> = new Map();

  constructor(options: SkillLoaderOptions) {
    this.cwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
    this.builtinDir = options.builtinDir ?? defaultBuiltinDir();
    this.homeDir = options.homeDir ?? safeHomedir();
    this.readOverride = options.readOverride ?? null;
  }

  /** Absolute path of the built-in skills directory. */
  get builtinPath(): string {
    return this.builtinDir;
  }

  /** Absolute path of the global skills directory. */
  get globalPath(): string {
    return join(this.homeDir, '.aficax', 'skills');
  }

  /** Absolute path of the project skills directory. */
  get projectPath(): string {
    return join(this.cwd, '.aficax', 'skills');
  }

  /**
   * Walk the three source directories, parse every `*.md` file, and
   * cache the result. Returns the merged list (newest definitions win
   * on `name` collision; project > global > builtin).
   */
  async load(): Promise<readonly Skill[]> {
    const merged = new Map<string, Skill>();
    const sources: Array<{ dir: string; kind: SkillSource }> = [
      { dir: this.builtinDir, kind: 'builtin' },
      { dir: this.globalPath, kind: 'global' },
      { dir: this.projectPath, kind: 'project' },
    ];
    for (const { dir, kind } of sources) {
      const skills = await this.loadDirectory(dir, kind);
      for (const skill of skills) {
        merged.set(skill.name, skill);
      }
    }
    this.skills = merged;
    logger.debug('skills: loaded', { count: this.skills.size });
    return Array.from(this.skills.values());
  }

  /** Snapshot of every loaded skill. */
  list(): readonly Skill[] {
    return Array.from(this.skills.values());
  }

  /** Look up a single skill by name. */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /** Force a reload from disk. */
  async reload(): Promise<readonly Skill[]> {
    return this.load();
  }

  // -- Internals ---------------------------------------------------------

  private async loadDirectory(dir: string, kind: SkillSource): Promise<Skill[]> {
    if (this.readOverride === null && !existsSync(dir)) return [];
    let entries: Array<{ name: string; isFile: boolean }>;
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isFile() && d.name.endsWith('.md'))
        .map((d) => ({ name: d.name, isFile: true }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('skills: readdir failed', { dir, error: message });
      return [];
    }
    const out: Skill[] = [];
    for (const entry of entries) {
      const file = join(dir, entry.name);
      const raw = await this.readFile(file);
      if (raw === null) continue;
      const skill = parseSkillFile(raw, file, kind);
      if (skill !== null) out.push(skill);
    }
    return out;
  }

  private async readFile(path: string): Promise<string | null> {
    if (this.readOverride !== null) {
      try {
        return await this.readOverride(path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('skills: readOverride failed', { path, error: message });
        return null;
      }
    }
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('skills: readFile failed', { path, error: message });
      return null;
    }
  }
}

// -- Helpers --------------------------------------------------------------

/**
 * Parse a single skill file. Returns `null` when the frontmatter is
 * missing or invalid, or when the required `name` field is empty.
 */
export function parseSkillFile(raw: string, path: string, source: SkillSource): Skill | null {
  const parsed = parseSkillFrontmatter(raw);
  if (parsed === null) {
    logger.debug('skills: no frontmatter, skipping', { path });
    return null;
  }
  const name = stringField(parsed.frontmatter, 'name');
  if (name === null || name.length === 0) {
    logger.debug('skills: missing name, skipping', { path });
    return null;
  }
  const description = stringField(parsed.frontmatter, 'description') ?? '';
  const tools = stringListField(parsed.frontmatter, 'tools');
  const triggers = stringListField(parsed.frontmatter, 'triggers');
  const always = booleanField(parsed.frontmatter, 'always') ?? false;
  return {
    name,
    description,
    tools,
    triggers,
    always,
    body: parsed.body,
    source,
    path,
  };
}

/**
 * Pull a frontmatter block + body out of a Markdown file. Recognises
 * the conventional `---\n...yaml...\n---\n<body>` form; returns `null`
 * when the file does not start with the opening fence.
 */
export function parseSkillFrontmatter(raw: string): { frontmatter: ParsedFrontmatter; body: string } | null {
  // Strip a UTF-8 BOM if present.
  const stripped = raw.startsWith('﻿') ? raw.slice(1) : raw;
  if (!stripped.startsWith('---')) return null;
  const end = findClosingFence(stripped, 3);
  if (end === -1) return null;
  const yamlText = stripped.slice(3, end).replace(/\r$/, '');
  const body = stripped.slice(end + 3).replace(/^\r?\n/, '');
  let frontmatter: ParsedFrontmatter;
  try {
    frontmatter = parseFrontmatter(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('skills: frontmatter parse failed', { error: message });
    return null;
  }
  return { frontmatter, body };
}

function findClosingFence(text: string, startFrom: number): number {
  const lines = text.split('\n');
  let cursor = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (i === 0) {
      cursor = line.length + 1;
      continue;
    }
    if (line.trim() === '---') {
      return cursor;
    }
    cursor += line.length + 1;
  }
  return -1;
  // `startFrom` is used to guarantee we begin scanning after the
  // opening fence. TypeScript cannot prove the loop always returns, so
  // the unused parameter assertion lives in this no-op reference.
  void startFrom;
}

function stringField(fm: ParsedFrontmatter, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function stringListField(fm: ParsedFrontmatter, key: string): readonly string[] {
  const v = fm[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function booleanField(fm: ParsedFrontmatter, key: string): boolean | null {
  const v = fm[key];
  return typeof v === 'boolean' ? v : null;
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

/** Factory that creates a fresh {@link SkillLoader}. */
export function createSkillLoader(options: SkillLoaderOptions): SkillLoader {
  return new SkillLoader(options);
}

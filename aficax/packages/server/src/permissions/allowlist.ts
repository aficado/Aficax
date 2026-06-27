// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\permissions\allowlist.ts
// Persistent allowlist / denylist for tool invocations.
//
// Entries are scoped at three levels, ordered from most specific to most
// general:
//   session  — in-memory only; cleared when the SessionStore forgets the
//              session. Used for "approve always" within a single run.
//   project  — persisted to `<cwd>/.aficax/allowlist.json`.
//   global   — persisted to `~/.aficax/allowlist.json`.
//
// An entry is a `{tool, inputPattern, addedAt, scope}` record. The pattern
// is a JavaScript regular expression matched against a per-tool
// "input signature" string (see {@link signatureFor}).

import {
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { getLogger, globalConfigDir, projectConfigDir } from '@aficax/core';
import type { ToolInput } from '@aficax/core';

const logger = getLogger();

/** Where an entry lives. */
export type AllowlistScope = 'session' | 'project' | 'global';

/** Which list an entry belongs to. */
export type ListKind = 'allow' | 'deny';

/** A single allowlist / denylist entry. */
export interface AllowlistEntry {
  /** Tool this rule applies to (exact name, case-sensitive). */
  readonly tool: string;
  /**
   * JavaScript regular expression source. Always matched against the
   * signature returned by {@link signatureFor}.
   */
  readonly inputPattern: string;
  /** Unix-ms timestamp the entry was added. */
  readonly addedAt: number;
  /** Scope the entry was added at. */
  readonly scope: AllowlistScope;
  /** Whether the entry is on the allow or deny list. */
  readonly list: ListKind;
}

/** On-disk shape. Versioned for forward-compat. */
interface AllowlistFile {
  readonly version: 1;
  readonly entries: readonly AllowlistEntry[];
}

/** Collaborators required to instantiate an {@link AllowlistStore}. */
export interface AllowlistStoreOptions {
  /**
   * Working directory used to resolve the project scope file. The session
   * scope is held in memory; this value is ignored for it.
   */
  readonly workingDir: string;
  /** Optional override for the global file path (tests). */
  readonly globalFilePath?: string;
  /** Optional override for the project file path (tests). */
  readonly projectFilePath?: string;
  /** Override the host clock (tests). */
  readonly now?: () => number;
}

const EMPTY_FILE: AllowlistFile = { version: 1, entries: [] };

/**
 * Allowlist / denylist store with three scopes. The store is pure with
 * respect to the session scope: it never touches the disk for it. The
 * project and global scopes are lazy-loaded on first access and reloaded
 * via {@link reload} when the file changes on disk.
 */
export class AllowlistStore {
  private readonly workingDir: string;
  private readonly globalFilePath: string;
  private readonly projectFilePath: string;
  private readonly now: () => number;

  /** In-memory session entries. Keyed by `scope` and `list` for fast access. */
  private readonly sessionEntries: Map<ListKind, AllowlistEntry[]> = new Map([
    ['allow', []],
    ['deny', []],
  ]);

  /** Cached entries loaded from disk. */
  private projectEntries: AllowlistEntry[] = [];
  private globalEntries: AllowlistEntry[] = [];

  /** Track whether we've already loaded from disk (lazy). */
  private projectLoaded = false;
  private globalLoaded = false;

  constructor(options: AllowlistStoreOptions) {
    this.workingDir = options.workingDir;
    this.globalFilePath =
      options.globalFilePath ?? `${globalConfigDir()}/allowlist.json`;
    this.projectFilePath =
      options.projectFilePath ??
      `${projectConfigDir(options.workingDir)}/allowlist.json`;
    this.now = options.now ?? Date.now;
  }

  // -- Public API --------------------------------------------------------

  /** Is `tool(input)` allowed by any entry (session > project > global)? */
  async isAllowed(tool: string, input: ToolInput): Promise<boolean> {
    return this.matchesAny(tool, input, 'allow');
  }

  /** Is `tool(input)` denied by any entry (session > project > global)? */
  async isDenied(tool: string, input: ToolInput): Promise<boolean> {
    return this.matchesAny(tool, input, 'deny');
  }

  /**
   * Add an entry to the allow list and persist it. When `scope` is `session`
   * the entry lives in memory only; otherwise the corresponding file is
   * reloaded and rewritten.
   */
  async addToAllowlist(
    tool: string,
    input: ToolInput,
    scope: AllowlistScope,
  ): Promise<AllowlistEntry> {
    return this.add(tool, input, scope, 'allow');
  }

  async addToDenylist(
    tool: string,
    input: ToolInput,
    scope: AllowlistScope,
  ): Promise<AllowlistEntry> {
    return this.add(tool, input, scope, 'deny');
  }

  /** Drop every entry that lives on the session scope. */
  clearSession(): void {
    this.sessionEntries.set('allow', []);
    this.sessionEntries.set('deny', []);
  }

  /** Drop every entry across every scope. */
  async clearAll(): Promise<void> {
    this.sessionEntries.set('allow', []);
    this.sessionEntries.set('deny', []);
    this.projectEntries = [];
    this.globalEntries = [];
    await this.writeProject({ version: 1, entries: [] });
    await this.writeGlobal({ version: 1, entries: [] });
  }

  /** Snapshot of every entry across every scope (for the UI). */
  async listEntries(): Promise<AllowlistEntry[]> {
    await this.ensureProjectLoaded();
    await this.ensureGlobalLoaded();
    return [
      ...this.sessionEntries.get('allow')!,
      ...this.sessionEntries.get('deny')!,
      ...this.projectEntries,
      ...this.globalEntries,
    ];
  }

  /** Force a re-read of the project and global files from disk. */
  async reload(): Promise<void> {
    this.projectLoaded = false;
    this.globalLoaded = false;
    await this.ensureProjectLoaded();
    await this.ensureGlobalLoaded();
  }

  // -- Internals ---------------------------------------------------------

  private async add(
    tool: string,
    input: ToolInput,
    scope: AllowlistScope,
    list: ListKind,
  ): Promise<AllowlistEntry> {
    const pattern = patternFor(tool, input);
    const entry: AllowlistEntry = {
      tool,
      inputPattern: pattern,
      addedAt: this.now(),
      scope,
      list,
    };
    if (scope === 'session') {
      const bucket = this.sessionEntries.get(list);
      if (bucket) {
        bucket.push(entry);
      }
      return entry;
    }

    if (scope === 'project') {
      await this.ensureProjectLoaded();
      this.projectEntries = [...this.projectEntries, entry];
      await this.writeProject({ version: 1, entries: this.projectEntries });
      return entry;
    }

    await this.ensureGlobalLoaded();
    this.globalEntries = [...this.globalEntries, entry];
    await this.writeGlobal({ version: 1, entries: this.globalEntries });
    return entry;
  }

  private async matchesAny(
    tool: string,
    input: ToolInput,
    list: ListKind,
  ): Promise<boolean> {
    const signature = signatureFor(tool, input);

    // Session scope is always consulted first.
    const sessionBucket = this.sessionEntries.get(list) ?? [];
    if (this.matchBucket(sessionBucket, tool, signature)) {
      return true;
    }

    // Project then global. We skip disk reads if the scope has been loaded
    // already — `await ensure*` is a no-op past the first call.
    if (list === 'allow' || list === 'deny') {
      await this.ensureProjectLoaded();
      if (this.matchBucket(this.projectEntries, tool, signature)) {
        return true;
      }
      await this.ensureGlobalLoaded();
      if (this.matchBucket(this.globalEntries, tool, signature)) {
        return true;
      }
    }
    return false;
  }

  private matchBucket(
    bucket: readonly AllowlistEntry[],
    tool: string,
    signature: string,
  ): boolean {
    for (const entry of bucket) {
      if (entry.tool !== tool) continue;
      if (matchesPattern(entry.inputPattern, signature)) {
        return true;
      }
    }
    return false;
  }

  private async ensureProjectLoaded(): Promise<void> {
    if (this.projectLoaded) return;
    this.projectEntries = await this.readFileSafe(this.projectFilePath);
    this.projectLoaded = true;
  }

  private async ensureGlobalLoaded(): Promise<void> {
    if (this.globalLoaded) return;
    this.globalEntries = await this.readFileSafe(this.globalFilePath);
    this.globalLoaded = true;
  }

  private async readFileSafe(path: string): Promise<AllowlistEntry[]> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      if (isMissingFile(err)) {
        return [];
      }
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Allowlist file could not be read', { path, error: message });
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Allowlist file is not valid JSON', { path, error: message });
      return [];
    }
    return normaliseEntries(parsed);
  }

  private async writeProject(file: AllowlistFile): Promise<void> {
    await this.writeFileSafe(this.projectFilePath, file);
  }

  private async writeGlobal(file: AllowlistFile): Promise<void> {
    await this.writeFileSafe(this.globalFilePath, file);
  }

  private async writeFileSafe(path: string, file: AllowlistFile): Promise<void> {
    const tmp = `${path}.tmp-${process.pid}-${String(Date.now())}`;
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(tmp, JSON.stringify(file, null, 2), 'utf-8');
      await rename(tmp, path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to write allowlist file', { path, error: message });
      // Best-effort: also try copying then renaming as a fallback.
      try {
        await copyFile(tmp, path);
      } catch {
        /* swallow */
      }
    }
  }
}

// -- Helpers --------------------------------------------------------------

/**
 * Build a stable, human-readable signature string for a tool's input.
 * Used both when adding an entry (the pattern is derived from it) and when
 * matching against an entry.
 */
export function signatureFor(tool: string, input: ToolInput): string {
  switch (tool) {
    case 'bash': {
      const cmd = input['command'];
      return typeof cmd === 'string' ? cmd.trim() : '';
    }
    case 'write_file':
    case 'edit_file':
    case 'patch_file':
    case 'read_file': {
      const path = input['path'];
      return typeof path === 'string' ? path : '';
    }
    default: {
      // For tools without a dedicated signature, fall back to a JSON dump
      // sorted by key. We rely on `JSON.stringify` determinism — object
      // key order in V8 is insertion order, which the input dict satisfies.
      try {
        return JSON.stringify(input);
      } catch {
        return '';
      }
    }
  }
}

/**
 * Build the regex pattern we store for an entry. By default we wrap the
 * trimmed signature in a `^...$` so partial matches require the user to
 * re-allow. Callers that want partial matching can edit the JSON manually.
 */
export function patternFor(tool: string, input: ToolInput): string {
  const sig = signatureFor(tool, input);
  if (sig.length === 0) {
    // Tools with empty signatures get a wildcard — there's nothing useful
    // to match on. The store still scopes by tool name.
    return '.*';
  }
  return `^${escapeRegex(sig)}$`;
}

/** Escape a string for safe inclusion as a regex source. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Test `signature` against `source`. Returns `false` on invalid regex. */
export function matchesPattern(source: string, signature: string): boolean {
  if (source === '.*') return true;
  let regex: RegExp;
  try {
    regex = new RegExp(source);
  } catch {
    return false;
  }
  return regex.test(signature);
}

function isMissingFile(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}

/** Coerce a parsed JSON payload into the canonical entries shape. */
function normaliseEntries(parsed: unknown): AllowlistEntry[] {
  if (typeof parsed !== 'object' || parsed === null) return [];
  const obj = parsed as Record<string, unknown>;
  const version = obj['version'];
  const entries = obj['entries'];
  if (version !== 1 || !Array.isArray(entries)) return [];
  const out: AllowlistEntry[] = [];
  for (const raw of entries) {
    if (!isAllowlistEntry(raw)) continue;
    out.push(raw);
  }
  return out;
}

function isAllowlistEntry(value: unknown): value is AllowlistEntry {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['tool'] !== 'string' || obj['tool'].length === 0) return false;
  if (typeof obj['inputPattern'] !== 'string') return false;
  if (typeof obj['addedAt'] !== 'number') return false;
  if (
    obj['scope'] !== 'session' &&
    obj['scope'] !== 'project' &&
    obj['scope'] !== 'global'
  ) {
    return false;
  }
  if (obj['list'] !== 'allow' && obj['list'] !== 'deny') return false;
  return true;
}

/** Factory that builds an {@link AllowlistStore} bound to a working dir. */
export function createAllowlistStore(options: AllowlistStoreOptions): AllowlistStore {
  return new AllowlistStore(options);
}

/** Re-export the empty-file shape for tests. */
export const __test__ = { EMPTY_FILE };

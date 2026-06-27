// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\hooks\registry.ts
// HookRegistry: owns the set of hooks the dispatcher will run.
//
// The registry reads `hooks.json` from two locations:
//
//   * `~/.aficax/hooks.json`    — global hooks
//   * `<cwd>/.aficax/hooks.json` — project-level hooks (appended to global)
//
// The two lists are merged with "project-wins" on `(event, command)`
// collisions: a project hook with the same event and command overrides
// the matching global entry. Hooks that exist only in one file are kept
// verbatim. The merge is idempotent.
//
// The registry optionally subscribes to a {@link FileWatcher} so changes
// to either file are picked up on the next `getHooks` call without
// requiring a server restart.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve } from 'node:path';

import { getLogger, globalConfigDir, projectConfigDir } from '@aficax/core';

import {
  DEFAULT_HOOK_TIMEOUT_MS,
  HOOK_EVENTS,
  type HookDefinition,
  type HookEvent,
  type HooksFile,
  type ResolvedHook,
} from './schema.js';

const logger = getLogger();

/** Public configuration of {@link HookRegistry}. */
export interface HookRegistryOptions {
  /**
   * Working directory used to locate the project-level `hooks.json`. The
   * global file is read from `~/.aficax/hooks.json`.
   */
  readonly cwd: string;
  /**
   * Override the home directory used to resolve the global file. Tests
   * inject a temp directory; production callers can leave it unset.
   */
  readonly homeDir?: string;
  /**
   * Optional override of the IO read for tests. Receives an absolute path
   * and returns the raw file body (empty string when the file is absent).
   */
  readonly readOverride?: (path: string) => Promise<string>;
  /**
   * Optional file-watcher factory. When provided, the returned object
   * arms watchers on the two `hooks.json` paths and reloads the registry
   * whenever they change. Tests pass a no-op.
   */
  readonly startWatcher?: (paths: readonly string[], onChange: () => void) => () => void;
}

/** In-memory bookkeeping for a single loaded file. */
interface SourceState {
  readonly path: string;
  readonly hooks: readonly HookDefinition[];
  /** Last mtime in ms; `0` when the file is missing. */
  readonly mtimeMs: number;
}

/**
 * The hook registry. Constructed once at server boot; `getHooks` is the
 * only hot-path entry point used by the dispatcher. Reloads happen
 * lazily on `getHooks` when a file change has been observed.
 */
export class HookRegistry {
  private readonly homeDir: string;
  private readonly cwd: string;
  private readonly readOverride: ((path: string) => Promise<string>) | null;
  private readonly stopWatcher: (() => void) | null;

  private global: SourceState = { path: '', hooks: [], mtimeMs: 0 };
  private project: SourceState = { path: '', hooks: [], mtimeMs: 0 };
  private merged: readonly ResolvedHook[] = [];
  private dirty = true;
  private watcherPaths: readonly string[] = [];

  constructor(options: HookRegistryOptions) {
    this.homeDir = options.homeDir ?? safeHomedir();
    this.cwd = isAbsolute(options.cwd) ? normalize(options.cwd) : resolve(options.cwd);
    this.readOverride = options.readOverride ?? null;
    this.stopWatcher = null;

    // Compute canonical paths so we can report them in error messages.
    this.global = {
      path: join(this.homeDir, '.aficax', 'hooks.json'),
      hooks: [],
      mtimeMs: 0,
    };
    this.project = {
      path: join(projectConfigDir(this.cwd), 'hooks.json'),
      hooks: [],
      mtimeMs: 0,
    };
    this.watcherPaths = [this.global.path, this.project.path];

    if (options.startWatcher !== undefined) {
      // Wrap the user's callback so file changes flip the dirty flag.
      this.stopWatcher = options.startWatcher(this.watcherPaths, () => {
        this.dirty = true;
        logger.debug('hooks: file change observed, will reload on next getHooks');
      });
    }
  }

  /** Absolute path to the global hooks file. */
  get globalPath(): string {
    return this.global.path;
  }

  /** Absolute path to the project-level hooks file. */
  get projectPath(): string {
    return this.project.path;
  }

  /** Return the merged list of hooks for a given event. */
  async getHooks(event: HookEvent): Promise<readonly ResolvedHook[]> {
    if (this.dirty) {
      await this.reload();
    }
    return this.merged.filter((h) => h.event === event && h.enabled);
  }

  /**
   * Force a reload of both `hooks.json` files from disk. Returns the new
   * merged list (handy for tests and the `/hooks` route).
   */
  async reload(): Promise<readonly ResolvedHook[]> {
    this.global = await this.readSource(this.global.path);
    this.project = await this.readSource(this.project.path);
    this.merged = mergeHooks(this.global, this.project);
    this.dirty = false;
    logger.debug('hooks: reloaded', {
      global: this.global.hooks.length,
      project: this.project.hooks.length,
      merged: this.merged.length,
    });
    return this.merged;
  }

  /** Snapshot of the current registry, grouped by event. */
  async snapshot(): Promise<Record<HookEvent, readonly ResolvedHook[]>> {
    if (this.dirty) {
      await this.reload();
    }
    const out: Record<HookEvent, readonly ResolvedHook[]> = {
      PreAPICall: [],
      PostAPICall: [],
      PreToolUse: [],
      PostToolUse: [],
      PreUserPromptSubmit: [],
      OnSessionStart: [],
      OnSessionEnd: [],
      OnError: [],
    };
    for (const hook of this.merged) {
      if (!hook.enabled) continue;
      (out[hook.event] as ResolvedHook[]).push(hook);
    }
    return out;
  }

  /** Stop the file watcher (idempotent). */
  dispose(): void {
    if (this.stopWatcher !== null) {
      try {
        this.stopWatcher();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('hooks: stopWatcher raised', { error: message });
      }
    }
  }

  // -- Internals ---------------------------------------------------------

  private async readSource(path: string): Promise<SourceState> {
    if (this.readOverride !== null) {
      let raw = '';
      try {
        raw = await this.readOverride(path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('hooks: readOverride failed', { path, error: message });
        return { path, hooks: [], mtimeMs: 0 };
      }
      return parseHooksFile(path, raw);
    }

    if (!existsSync(path)) {
      return { path, hooks: [], mtimeMs: 0 };
    }
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('hooks: readFile failed', { path, error: message });
      return { path, hooks: [], mtimeMs: 0 };
    }
    let mtimeMs = 0;
    try {
      const { stat } = await import('node:fs/promises');
      const info = await stat(path);
      mtimeMs = info.mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    return parseHooksFile(path, raw, mtimeMs);
  }
}

// -- Helpers --------------------------------------------------------------

function parseHooksFile(path: string, raw: string, mtimeMs = 0): SourceState {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { path, hooks: [], mtimeMs };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('hooks: file is not valid JSON', { path, error: message });
    return { path, hooks: [], mtimeMs };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { path, hooks: [], mtimeMs };
  }
  const obj = parsed as Record<string, unknown>;
  const hooksRaw = obj['hooks'];
  if (!Array.isArray(hooksRaw)) {
    return { path, hooks: [], mtimeMs };
  }
  const out: HookDefinition[] = [];
  for (const entry of hooksRaw) {
    const norm = normaliseFromUnknown(entry);
    if (norm !== null) out.push(norm);
  }
  return { path, hooks: out, mtimeMs };
}

function normaliseFromUnknown(raw: unknown): HookDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const event = obj['event'];
  if (typeof event !== 'string' || !HOOK_EVENTS.includes(event as HookEvent)) return null;
  const command = obj['command'];
  if (typeof command !== 'string' || command.length === 0) return null;
  const timeoutRaw = obj['timeout'];
  const timeout = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.floor(timeoutRaw)
    : DEFAULT_HOOK_TIMEOUT_MS;
  const onFailureRaw = obj['onFailure'];
  const onFailure: 'abort' | 'continue' = onFailureRaw === 'continue' ? 'continue' : 'abort';
  const enabledRaw = obj['enabled'];
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : true;
  return { event: event as HookEvent, command, timeout, onFailure, enabled };
}

function mergeHooks(
  global: SourceState,
  project: SourceState,
): readonly ResolvedHook[] {
  const map = new Map<string, ResolvedHook>();
  for (const hook of global.hooks) {
    map.set(hookKey(hook), resolveHook(hook, 'global'));
  }
  for (const hook of project.hooks) {
    map.set(hookKey(hook), resolveHook(hook, 'project'));
  }
  return Array.from(map.values());
}

function hookKey(hook: HookDefinition): string {
  return `${hook.event}::${hook.command}`;
}

function resolveHook(hook: HookDefinition, source: 'global' | 'project'): ResolvedHook {
  return { ...hook, source, timeoutMs: hook.timeout };
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

// Touch the imported globalConfigDir to ensure the import survives
// dead-code elimination; it is consumed by projectConfigDir on line 1.
void globalConfigDir;

/** Factory that creates a fresh {@link HookRegistry}. */
export function createHookRegistry(options: HookRegistryOptions): HookRegistry {
  return new HookRegistry(options);
}

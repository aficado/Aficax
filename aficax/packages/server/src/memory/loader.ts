// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\memory\loader.ts
// MemoryLoader: assembles the memory context for a turn.
//
// Resolution order (later sources override earlier ones when concatenated):
//
//   1. `~/.aficax/MEMORY.md`   — global user preferences (cross-project)
//   2. `~/.aficax/AFICAX.md`   — global Aficax instructions
//   3. `<cwd>/AFICAX.md`       — project-level instructions
//   4. `<cwd>/<subdir>/AFICAX.md` — directory-level overrides (when present)
//
// Each AFICAX.md is capped to 50 KB / 500 lines, MEMORY.md to 25 KB /
// 200 lines (whatever is smaller). The result is returned as a single
// `combined` string ready to be injected into the system prompt, plus
// per-section projections so callers can decide what to do with each part.

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

import { estimateTokens, getLogger } from '@aficax/core';

import { MemoryStore, type MemoryFile } from './store.js';

const logger = getLogger();

/** Maximum number of lines read from an AFICAX.md file. */
const AFICAX_MD_MAX_LINES = 500;
/** Maximum number of lines read from MEMORY.md. */
const MEMORY_MD_MAX_LINES = 200;

/** Maximum number of sub-directories to scan for nested AFICAX.md files. */
const MAX_SUBDIR_DEPTH = 2;

/** Result of {@link MemoryLoader.load}. */
export interface LoadedMemory {
  /** Raw content of `~/.aficax/MEMORY.md` (capped). May be empty. */
  readonly globalMemory: string;
  /** Raw content of `~/.aficax/AFICAX.md` (capped). May be empty. */
  readonly globalAficax: string;
  /** Raw content of `<cwd>/AFICAX.md` (capped). May be empty. */
  readonly projectAficax: string;
  /** Raw content of nested AFICAX.md files, keyed by absolute path. */
  readonly directoryAficax: ReadonlyMap<string, string>;
  /** Concatenated text in load order, ready to inject into the prompt. */
  readonly combined: string;
  /** Token estimate of `combined` using the core heuristic. */
  readonly tokenCount: number;
  /** Per-file metadata (path + size) for logging and the `/memory` route. */
  readonly files: readonly MemoryFile[];
}

/** Public configuration of {@link MemoryLoader}. */
export interface MemoryLoaderOptions {
  /**
   * Override the working directory used to resolve the project-level
   * AFICAX.md and the nested directory walk.
   */
  readonly cwd: string;
  /**
   * Inject a custom store (tests). Defaults to a fresh {@link MemoryStore}.
   */
  readonly store?: MemoryStore;
  /**
   * Maximum sub-directory depth to scan for nested AFICAX.md files.
   * Defaults to {@link MAX_SUBDIR_DEPTH}; pass `0` to skip the scan.
   */
  readonly maxSubdirDepth?: number;
  /**
   * Optional override of the IO read for tests. Receives an absolute
   * path and must return the file's content (empty string when missing).
   */
  readonly readOverride?: (path: string) => Promise<string>;
}

/**
 * Resolves and assembles the memory content for a session. Constructed
 * once per session; methods are stateless and safe to re-invoke.
 */
export class MemoryLoader {
  private readonly store: MemoryStore;
  private readonly cwd: string;
  private readonly maxSubdirDepth: number;
  private readonly readOverride: ((path: string) => Promise<string>) | null;

  constructor(options: MemoryLoaderOptions) {
    this.store = options.store ?? new MemoryStore();
    this.cwd = isAbsolute(options.cwd) ? normalize(options.cwd) : resolve(options.cwd);
    this.maxSubdirDepth = options.maxSubdirDepth ?? MAX_SUBDIR_DEPTH;
    this.readOverride = options.readOverride ?? null;
  }

  /**
   * Build the full memory payload for the current working directory. Each
   * section is read independently and capped; missing files contribute an
   * empty string and are silently skipped.
   */
  async load(): Promise<LoadedMemory> {
    const globalMemory = await this.readCapped(this.store.globalMemoryMdPath, MEMORY_MD_MAX_LINES);
    const globalAficax = await this.readCapped(this.store.globalAficaxMdPath, AFICAX_MD_MAX_LINES);
    const projectPath = this.store.resolveProjectAficaxMd(this.cwd);
    const projectAficax = await this.readCapped(projectPath, AFICAX_MD_MAX_LINES);

    const directoryAficax = new Map<string, string>();
    if (this.maxSubdirDepth > 0) {
      const nested = await this.collectNestedAficax(this.cwd, this.maxSubdirDepth);
      for (const [path, content] of nested) {
        directoryAficax.set(path, content);
      }
    }

    const combined = this.assemble(globalMemory, globalAficax, projectAficax, directoryAficax);
    const tokenCount = estimateTokens(combined);

    const files: MemoryFile[] = [
      { path: this.store.globalMemoryMdPath, content: globalMemory, sizeBytes: globalMemory.length, mtimeMs: 0 },
      { path: this.store.globalAficaxMdPath, content: globalAficax, sizeBytes: globalAficax.length, mtimeMs: 0 },
      { path: projectPath, content: projectAficax, sizeBytes: projectAficax.length, mtimeMs: 0 },
    ];
    for (const [path, content] of directoryAficax) {
      files.push({ path, content, sizeBytes: content.length, mtimeMs: 0 });
    }

    return {
      globalMemory,
      globalAficax,
      projectAficax,
      directoryAficax,
      combined,
      tokenCount,
      files,
    };
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Read a file, cap it to the first `maxLines`, and trim trailing blank
   * lines. Empty content is returned as an empty string.
   */
  private async readCapped(path: string, maxLines: number): Promise<string> {
    let raw: string;
    if (this.readOverride !== null) {
      try {
        raw = await this.readOverride(path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('readOverride failed', { path, error: message });
        return '';
      }
    } else {
      const file = await this.store.readAficaxMd(path);
      raw = file.content;
    }
    if (raw.length === 0) return '';
    const lines = raw.split('\n');
    const head = lines.slice(0, maxLines);
    while (head.length > 0 && (head[head.length - 1] ?? '').trim().length === 0) {
      head.pop();
    }
    return head.join('\n');
  }

  /**
   * Walk `cwd` up to `depth` levels and return every AFICAX.md found
   * (excluding the project-root one, which is already handled separately).
   * Hidden directories and `node_modules` are skipped to keep the walk
   * cheap on typical projects.
   */
  private async collectNestedAficax(
    cwd: string,
    depth: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (depth <= 0) return out;
    const queue: Array<{ path: string; remaining: number }> = [
      { path: cwd, remaining: depth },
    ];
    const projectAficaxPath = this.store.resolveProjectAficaxMd(cwd);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      let entries;
      try {
        entries = await readdir(current.path, { withFileTypes: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('readdir failed during memory walk', {
          path: current.path,
          error: message,
        });
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isFile()) continue;
        if (entry.name.startsWith('.')) continue;
        if (entry.name === 'node_modules') continue;
        const childPath = join(current.path, entry.name);
        if (entry.isFile() && entry.name === 'AFICAX.md' && childPath !== projectAficaxPath) {
          const content = await this.readCapped(childPath, AFICAX_MD_MAX_LINES);
          if (content.length > 0) {
            out.set(childPath, content);
          }
          continue;
        }
        if (entry.isDirectory() && current.remaining > 1) {
          queue.push({ path: childPath, remaining: current.remaining - 1 });
        }
      }
    }
    return out;
  }

  /**
   * Concatenate the four sources in load order, separated by horizontal
   * rules so the prompt remains readable.
   */
  private assemble(
    globalMemory: string,
    globalAficax: string,
    projectAficax: string,
    directoryAficax: ReadonlyMap<string, string>,
  ): string {
    const sections: string[] = [];
    if (globalMemory.length > 0) {
      sections.push(this.wrap('# User Preferences (MEMORY.md)', globalMemory));
    }
    if (globalAficax.length > 0) {
      sections.push(this.wrap('# Global Instructions (~/.aficax/AFICAX.md)', globalAficax));
    }
    if (projectAficax.length > 0) {
      sections.push(this.wrap('# Project Instructions (AFICAX.md)', projectAficax));
    }
    if (directoryAficax.size > 0) {
      const blocks: string[] = [];
      const sorted = Array.from(directoryAficax.entries()).sort(([a], [b]) => a.localeCompare(b));
      for (const [path, content] of sorted) {
        const label = this.directoryLabel(path);
        blocks.push(this.wrap(`## ${label}`, content));
      }
      sections.push(`# Directory Overrides\n\n${blocks.join('\n\n')}`);
    }
    return sections.join('\n\n---\n\n');
  }

  private wrap(title: string, body: string): string {
    return `${title}\n\n${body}`;
  }

  /**
   * Produce a human-friendly label for a nested AFICAX.md, e.g.
   * `<cwd>/packages/server/AFICAX.md` becomes `packages/server/AFICAX.md`.
   */
  private directoryLabel(path: string): string {
    const rel = relative(this.cwd, path);
    if (rel.length === 0 || rel.startsWith('..')) {
      return path.split(sep).slice(-2).join(sep);
    }
    return rel;
  }
}

/**
 * Verify that `path` exists and is a regular file. Used by callers that
 * need to know whether a memory file is present (e.g. the `/memory` route
 * decides between a 200 with content and a 404).
 */
export async function memoryFileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Factory that creates a fresh {@link MemoryLoader} bound to a cwd. */
export function createMemoryLoader(options: MemoryLoaderOptions): MemoryLoader {
  return new MemoryLoader(options);
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\memory\store.ts
// MemoryStore: low-level read / write helpers for the Aficax memory files.
//
// The store is the only module that touches the on-disk representation of
// AFICAX.md and MEMORY.md. Higher layers (loader, extractor, watcher) use
// these helpers so the file layout lives in exactly one place.
//
// Conventions
// -----------
// * `AFICAX.md` — per-project or per-directory instructions, one per
//   directory. Written by humans or the auto-memory extractor (append-only).
// * `MEMORY.md`  — single global file under `~/.aficax/MEMORY.md`. Holds the
//   user's cross-project preferences. Overwritten (not appended) on write.
//
// All write helpers are atomic: they write to a temporary file in the same
// directory and rename it into place so a crash mid-write cannot leave a
// half-written memory file behind.

import {
  access,
  constants as fsConstants,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

import { getLogger } from '@aficax/core';

const logger = getLogger();

/** Maximum number of bytes accepted from an AFICAX.md file (50 KB). */
export const AFICAX_MD_MAX_BYTES = 50 * 1024;
/** Maximum number of bytes accepted from MEMORY.md (25 KB). */
export const MEMORY_MD_MAX_BYTES = 25 * 1024;

/** Result of a single read against an existing memory file. */
export interface MemoryFile {
  /** Absolute path that was read. */
  readonly path: string;
  /** UTF-8 decoded content. Empty string when the file is missing. */
  readonly content: string;
  /** Size in bytes after the read (0 when missing). */
  readonly sizeBytes: number;
  /** Last modified time in ms (0 when missing). */
  readonly mtimeMs: number;
}

/** Public configuration of {@link MemoryStore}. */
export interface MemoryStoreOptions {
  /**
   * Override the home directory used to resolve the global files. Tests
   * inject a temp directory; production callers can leave it unset.
   */
  readonly homeDir?: string;
}

/**
 * Thin filesystem wrapper around the Aficax memory files. Constructed
 * once per server process; every helper is safe to call concurrently.
 */
export class MemoryStore {
  private readonly homeDir: string;

  constructor(options: MemoryStoreOptions = {}) {
    this.homeDir = options.homeDir ?? safeHomedir();
  }

  /** Absolute path to `~/.aficax/AFICAX.md`. */
  get globalAficaxMdPath(): string {
    return join(this.homeDir, '.aficax', 'AFICAX.md');
  }

  /** Absolute path to `~/.aficax/MEMORY.md`. */
  get globalMemoryMdPath(): string {
    return join(this.homeDir, '.aficax', 'MEMORY.md');
  }

  /**
   * Resolve the project-level AFICAX.md path from a working directory.
   * Accepts relative or absolute input; always returns an absolute path.
   */
  resolveProjectAficaxMd(cwd: string): string {
    const base = isAbsolute(cwd) ? normalize(cwd) : resolve(cwd);
    return join(base, 'AFICAX.md');
  }

  /** Read an AFICAX.md file at the given absolute path. */
  async readAficaxMd(path: string): Promise<MemoryFile> {
    return this.readCapped(path, AFICAX_MD_MAX_BYTES);
  }

  /** Read the global `~/.aficax/AFICAX.md` file. */
  async readGlobalAficaxMd(): Promise<MemoryFile> {
    return this.readAficaxMd(this.globalAficaxMdPath);
  }

  /** Read the global `~/.aficax/MEMORY.md` file (capped to 25 KB). */
  async readMemoryMd(): Promise<MemoryFile> {
    return this.readCapped(this.globalMemoryMdPath, MEMORY_MD_MAX_BYTES);
  }

  /**
   * Overwrite an AFICAX.md file. Creates parent directories as needed.
   * The write is atomic (write to `.<name>.tmp` then `rename`) so a crash
   * cannot leave a half-written file behind.
   */
  async writeAficaxMd(path: string, content: string): Promise<void> {
    await this.atomicWrite(path, content);
  }

  /**
   * Append `content` to an AFICAX.md file, creating it when missing. The
   * new content is preceded by a blank line so it stays a valid Markdown
   * document even if the existing file did not end with a newline.
   */
  async appendAficaxMd(path: string, content: string): Promise<void> {
    const existing = await this.readAficaxMd(path);
    const tail = existing.content.length === 0
      ? content
      : existing.content.endsWith('\n')
        ? `${existing.content}${content}`
        : `${existing.content}\n\n${content}`;
    await this.writeAficaxMd(path, tail);
  }

  /**
   * Append a Markdown section under `sectionTitle`. The first match wins:
   * if a heading with that exact text already exists, the new content is
   * appended under the existing section; otherwise a new section header is
   * created. Returns `true` when the section was newly created, `false`
   * when it already existed.
   */
  async appendToSection(
    path: string,
    sectionTitle: string,
    content: string,
  ): Promise<boolean> {
    const existing = await this.readAficaxMd(path);
    const heading = sectionTitle.trim();
    if (heading.length === 0) {
      throw new Error('sectionTitle must be a non-empty string');
    }
    const lines = existing.content.split('\n');
    const normalised = heading.toLowerCase();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (m === null) continue;
      if (m[2] !== undefined && m[2].toLowerCase() === normalised) {
        // Insert just before the next heading of the same or higher level
        // (or before EOF if no such heading follows).
        const level = m[1] ?? '#';
        const nextIndex = findNextHeading(lines, i + 1, level);
        const block = ensureTrailingNewline(content);
        const newLines = [
          ...lines.slice(0, nextIndex),
          block,
          ...lines.slice(nextIndex),
        ];
        await this.writeAficaxMd(path, newLines.join('\n'));
        return false;
      }
    }

    // No existing section — create one at the end of the file.
    const header = existing.content.length === 0
      ? `## ${heading}\n\n`
      : existing.content.endsWith('\n')
        ? `## ${heading}\n\n`
        : `\n\n## ${heading}\n\n`;
    await this.writeAficaxMd(path, `${existing.content}${header}${ensureTrailingNewline(content)}`);
    return true;
  }

  /**
   * Overwrite the global `~/.aficax/MEMORY.md` file. Creates the parent
   * directory and the file when missing.
   */
  async writeMemoryMd(content: string): Promise<void> {
    await this.atomicWrite(this.globalMemoryMdPath, content);
  }

  /** Overwrite the global `~/.aficax/AFICAX.md` file. */
  async writeGlobalAficaxMd(content: string): Promise<void> {
    await this.atomicWrite(this.globalAficaxMdPath, content);
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Read a UTF-8 text file and cap the response to `maxBytes`. The returned
   * `content` is never larger than `maxBytes`; bytes past the cap are
   * silently truncated.
   */
  private async readCapped(path: string, maxBytes: number): Promise<MemoryFile> {
    let info;
    try {
      await access(path, fsConstants.R_OK);
      info = await stat(path);
    } catch {
      return { path, content: '', sizeBytes: 0, mtimeMs: 0 };
    }
    if (!info.isFile()) {
      return { path, content: '', sizeBytes: info.size, mtimeMs: info.mtimeMs };
    }
    let data: Buffer;
    try {
      data = await readFile(path);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('readFile failed for memory file', { path, error: message });
      return { path, content: '', sizeBytes: info.size, mtimeMs: info.mtimeMs };
    }
    const slice = data.subarray(0, Math.min(maxBytes, data.length));
    const text = new TextDecoder('utf-8').decode(slice);
    return {
      path,
      content: text,
      sizeBytes: info.size,
      mtimeMs: info.mtimeMs,
    };
  }

  /** Atomic write: tmp + rename. */
  private async atomicWrite(path: string, content: string): Promise<void> {
    const absolute = isAbsolute(path) ? path : resolve(path);
    const dir = dirname(absolute);
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.${basenameOf(absolute)}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(tmp, content, { encoding: 'utf-8' });
    try {
      await rename(tmp, absolute);
    } catch (err) {
      // If the rename fails (e.g. cross-device on some platforms) fall
      // back to a direct write; the read API will still return the new
      // content on the next call.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('atomic rename failed, falling back to direct write', {
        path: absolute,
        error: message,
      });
      await writeFile(absolute, content, { encoding: 'utf-8' });
    }
  }
}

// -- Helpers --------------------------------------------------------------

function findNextHeading(lines: readonly string[], start: number, level: string): number {
  const rank = level.length;
  for (let i = start; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? '');
    if (m !== null && m[1] !== undefined && m[1].length <= rank) {
      return i;
    }
  }
  return lines.length;
}

function ensureTrailingNewline(content: string): string {
  if (content.length === 0) return '';
  return content.endsWith('\n') ? content : `${content}\n`;
}

function basenameOf(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx === -1) return path;
  return path.slice(idx + 1);
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

/** Factory that creates a fresh {@link MemoryStore}. */
export function createMemoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(options);
}

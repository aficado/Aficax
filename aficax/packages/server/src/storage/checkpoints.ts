// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\checkpoints.ts
// File-history checkpoints. Phase 2's `write_file` tool already creates a
// copy of the file in ~/.aficax/file-history/<sessionId>/<ts>_<safeName>
// before overwriting; this module lists those checkpoints and restores them.

import { copyFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { fileHistoryDir } from '@aficax/core';

/** Metadata for a single file checkpoint. */
export interface CheckpointEntry {
  /** Absolute path of the checkpoint file on disk. */
  readonly checkpointPath: string;
  /** ISO timestamp parsed out of the filename prefix. */
  readonly timestamp: number;
  /** The original file path reconstructed from the suffix (best effort). */
  readonly originalPath: string;
  /** Size of the checkpoint in bytes. */
  readonly size: number;
}

/** Return the path to the checkpoint that backs the most recent write of `filePath`. */
export async function rewindFile(
  sessionId: string,
  filePath: string,
): Promise<{ checkpointPath: string; originalPath: string }> {
  const dir = fileHistoryDir(sessionId);
  const safe = safeCheckpointName(filePath);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const suffix = `_${safe}`;
  const candidates = entries
    .filter((name) => name.endsWith(suffix))
    .sort();
  if (candidates.length === 0) {
    throw new Error(`No checkpoint found for "${filePath}" in session ${sessionId}`);
  }
  // Sorted lexicographically → newest timestamp last.
  const latest = candidates[candidates.length - 1];
  if (latest === undefined) {
    throw new Error(`No checkpoint found for "${filePath}" in session ${sessionId}`);
  }
  const checkpointPath = joinPaths(dir, latest);
  await copyFile(checkpointPath, filePath);
  return { checkpointPath, originalPath: filePath };
}

/** Best-effort delete of a restored file (used by tests and maintenance tools). */
export async function deleteCheckpointFile(path: string): Promise<void> {
  await unlink(path).catch(() => {
    /* swallow */
  });
}

/** Return every checkpoint for a session, newest first. */
export async function listCheckpoints(sessionId: string): Promise<CheckpointEntry[]> {
  const dir = fileHistoryDir(sessionId);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir).catch(() => [] as string[]);
  const out: CheckpointEntry[] = [];
  for (const name of entries) {
    const checkpointPath = joinPaths(dir, name);
    const stat = await import('node:fs/promises').then((m) => m.stat(checkpointPath));
    if (!stat.isFile()) {
      continue;
    }
    const parsed = parseCheckpointName(name);
    if (parsed === null) {
      continue;
    }
    out.push({
      checkpointPath,
      timestamp: parsed.timestamp,
      originalPath: parsed.originalPath,
      size: stat.size,
    });
  }
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}

/** Replicate the sanitisation used by `write_file` so checkpoints can be located by name. */
function safeCheckpointName(absolutePath: string): string {
  return absolutePath.replace(/[:\\/]/g, '_');
}

/** Parse `<isoTimestamp>_<safePath>` back into its components. */
function parseCheckpointName(name: string): { timestamp: number; originalPath: string } | null {
  const idx = name.indexOf('_');
  if (idx <= 0) {
    return null;
  }
  const tsRaw = name.slice(0, idx);
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || ts <= 0) {
    return null;
  }
  const safeRest = name.slice(idx + 1);
  if (safeRest.length === 0) {
    return null;
  }
  // The sanitisation replaced path separators with `_`, so we can only
  // return a best-effort representation: the original path on Windows
  // often includes a drive letter (e.g. C__Users_...). The caller can
  // display this as a "checkpointed path" without the leading separator.
  return { timestamp: ts, originalPath: safeRest.replace(/_/g, '/') };
}

/** Tiny helper to avoid importing `node:path` at the top. */
function joinPaths(a: string, b: string): string {
  // Lightweight join that works on both POSIX and Windows.
  const sep = a.includes('\\') ? '\\' : '/';
  if (a.endsWith('/') || a.endsWith('\\')) {
    return a + b;
  }
  return a + sep + b;
}

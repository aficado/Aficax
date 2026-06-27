// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\utils\paths.ts
// Resolves Aficax's well-known filesystem locations. All functions are pure:
// they do not touch the filesystem, they only construct absolute paths.

import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

/** Folder name used for the global Aficax user directory. */
const GLOBAL_DIR_NAME = '.aficax';
/** Folder name used for the per-project Aficax directory. */
const PROJECT_DIR_NAME = '.aficax';
/** Subfolder that holds per-session transcripts and metadata. */
const SESSIONS_DIR_NAME = 'sessions';
/** Subfolder that holds per-session file checkpoints for rewind. */
const FILE_HISTORY_DIR_NAME = 'file-history';
/** Filename of the global Aficax instructions file. */
const GLOBAL_AFICAX_MD = 'AFICAX.md';

/** Resolve the global Aficax configuration directory (~/.aficax). */
export function globalConfigDir(): string {
  return join(homedir(), GLOBAL_DIR_NAME);
}

/** Resolve the per-project Aficax directory (<cwd>/.aficax). */
export function projectConfigDir(cwd: string): string {
  return join(normalize(cwd), PROJECT_DIR_NAME);
}

/** Resolve the directory that holds every persisted session. */
export function sessionsDir(): string {
  return join(globalConfigDir(), SESSIONS_DIR_NAME);
}

/** Resolve the per-session file-history directory used by rewind. */
export function fileHistoryDir(sessionId: string): string {
  return join(globalConfigDir(), FILE_HISTORY_DIR_NAME, sessionId);
}

/** Resolve the path to the global Aficax instructions file. */
export function globalAficaxMd(): string {
  return join(globalConfigDir(), GLOBAL_AFICAX_MD);
}

/** Resolve the path to the project-level Aficax instructions file. */
export function projectAficaxMd(cwd: string): string {
  return join(normalize(cwd), GLOBAL_AFICAX_MD);
}

/** Convenience: per-session storage directory under the sessions root. */
export function sessionDir(sessionId: string): string {
  return join(sessionsDir(), sessionId);
}

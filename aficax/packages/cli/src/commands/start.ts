// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\start.ts
// `aficax start` — boot the server and connect the TUI.
//
// Architecture: this command is a thin orchestrator. It spawns the
// server as a child process (`bin.ts`), waits for `/health` to return
// 200, then spawns the TUI client (`@aficax/tui`) with
// `AFICAX_SERVER_URL` pointed at the server. When the TUI exits
// (Ctrl+D, /exit, or terminal close), the server is shut down and
// the command returns.
//
// Why child processes (not in-process): spawning both sides cleanly
// matches what Claude Code / OpenCode / Qwen Code do (the server
// keeps running if you detach the TUI; the TUI can be reattached
// later), and it avoids the import-side-effect bug where importing
// `@aficax/server` would auto-boot the server.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { render } from 'ink';
import React from 'react';
import { getLogger, setLogLevel } from '@aficax/core';

import { App } from '@aficax/tui/app';
import { AficaxClient } from '@aficax/tui/client/api';

import type { CliFlags } from '../index.js';

const logger = getLogger();

/** Path to the server's binary entrypoint inside the workspace. */
function resolveServerPath(workspaceRoot: string): string | null {
  const candidates = [
    join(workspaceRoot, 'packages', 'server', 'src', 'bin.ts'),
    join(workspaceRoot, 'apps', 'server', 'src', 'bin.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Path to the TUI entry. Looks in several common layouts, including
 *  a sibling of the workspace root (the `Aficax/` monorepo layout).
 *  Every candidate is resolved before the existence check so paths
 *  containing `..` behave correctly on Windows. */
function resolveTuiPath(workspaceRoot: string): string | null {
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ['packages', 'tui'],
    ['apps', 'tui'],
  ];
  const filenames = ['index.tsx', 'index.ts'];
  for (const [a, b] of candidates) {
    for (const filename of filenames) {
      const direct = resolve(workspaceRoot, a, b, 'src', filename);
      if (existsSync(direct)) return direct;
      const sibling = resolve(workspaceRoot, '..', a, b, 'src', filename);
      if (existsSync(sibling)) return sibling;
    }
  }
  return null;
}

/**
 * Resolve the Aficax workspace root.
 *
 * Precedence:
 *   1. `AFICAX_HOME` environment variable (set by the `.cmd` wrapper
 *      and by integration tests; points at the directory holding
 *      `packages/server/src/bin.ts` and `packages/cli`).
 *   2. `AFICAX_BIN_DIR` environment variable (the directory of the
 *      running executable). We walk up from there looking for
 *      `package.json` so `bun run` from the monorepo also works.
 *   3. Walk up from `start` looking for the first directory that
 *      contains `package.json`.
 *   4. Fall back to `start` itself.
 */
function findWorkspaceRoot(start: string): string {
  const homeEnv = process.env['AFICAX_HOME'];
  if (typeof homeEnv === 'string' && homeEnv.length > 0 && existsSync(join(homeEnv, 'package.json'))) {
    return homeEnv;
  }
  const binDir = process.env['AFICAX_BIN_DIR'];
  if (typeof binDir === 'string' && binDir.length > 0) {
    let dir = binDir;
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, 'package.json'))) return dir;
      const parent = resolve(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  }
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return start;
}

/** Wait for the server's /health endpoint to respond with 2xx. */
async function waitForHealth(url: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy at ${url} within ${String(timeoutMs)} ms`);
}

export async function runStartCommand(flags: CliFlags): Promise<void> {
  // The CLI itself logs boot / shutdown messages through the shared
  // Logger. Without a filter these would print as JSON lines to the
  // user's terminal *before* Ink has a chance to render the TUI,
  // which looks unprofessional (Claude Code never prints these).
  // Setting the level to ERROR hides the INFO chatter (booting
  // server / server is healthy / shutdown complete) while still
  // surfacing genuine failures via `logger.error(...)`. `--debug`
  // opts back into the verbose level.
  setLogLevel(flags.debug ? 'DEBUG' : 'ERROR');

  const cwd = flags.workingDir
    ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir))
    : process.cwd();
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  const serverUrl = `http://${host}:${String(port)}`;

  const workspaceRoot = findWorkspaceRoot(cwd);
  const serverPath = resolveServerPath(workspaceRoot);

  if (serverPath === null) {
    throw new Error(
      `could not locate the server entrypoint. Looked in ${workspaceRoot}/packages/server/src/bin.ts. ` +
        `Run from the Aficax monorepo root or pass --working-dir.`,
    );
  }

  logger.info('start: booting server', { host, port, cwd, serverPath });

  // -- 1. Spawn the server ------------------------------------------------
  const serverEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AFICAX_PORT: String(port),
    AFICAX_HOST: host,
    AFICAX_CWD: cwd,
  };
  if (flags.model !== undefined) serverEnv['AFICAX_MODEL'] = flags.model;
  if (flags.provider !== undefined) serverEnv['AFICAX_PROVIDER'] = flags.provider;
  if (flags.workingDir !== undefined) serverEnv['AFICAX_CWD'] = flags.workingDir;
  if (flags.noSandbox) serverEnv['AFICAX_NO_SANDBOX'] = '1';
  if (flags.mode !== undefined) serverEnv['AFICAX_MODE'] = flags.mode;
  if (flags.maxTurns !== undefined) serverEnv['AFICAX_MAX_TURNS'] = String(flags.maxTurns);
  if (flags.maxTokens !== undefined) serverEnv['AFICAX_MAX_TOKENS'] = String(flags.maxTokens);
  // Default to `warn` so the server does not flood the TTY. Users
  // who want verbose logs can pass `--debug` (sets it to debug).
  serverEnv['AFICAX_LOG_LEVEL'] = flags.debug ? 'debug' : 'warn';

  // The runtime to spawn. Default to `bun` on PATH; honour the
  // `AFICAX_BUN_EXE` env var so the wrapper can pass an absolute path
  // when the child cannot find `bun` via PATH.
  const bunBin = process.env['AFICAX_BUN_EXE'] ?? 'bun';

  // The server's stdio is fully detached by default so the TUI's
  // rendering stays clean — the JSON log lines the server emits to
  // stderr would otherwise interleave with Ink's output and make the
  // chat unreadable. When `--debug` is set we pipe the server's
  // stderr through so the user can still see the log trail.
  const serverStdio: 'inherit' | ['ignore', 'ignore', 'ignore'] = flags.debug
    ? 'inherit'
    : ['ignore', 'ignore', 'ignore'];
  const server: ChildProcess = spawn(bunBin, ['run', serverPath], {
    env: serverEnv,
    cwd,
    stdio: serverStdio,
  });

  server.on('error', (err) => {
    logger.error('start: server failed to spawn', { error: err.message });
  });

  // -- 2. Wait for the server to come up ---------------------------------
  try {
    await waitForHealth(`${serverUrl}/health`);
    logger.info('start: server is healthy', { serverUrl });
  } catch (err) {
    server.kill();
    throw err;
  }

  // -- 3. Render the TUI inline -------------------------------------------
  //
  // The TUI used to be spawned as a child process with `stdio: 'inherit'`,
  // but that path is fragile on Windows: the child's stdin handle is a
  // duplicate of the parent's, and when Bun's compiled runtime is the
  // parent the TUI can exit almost immediately after rendering. Inlining
  // the React tree into the CLI process makes the lifecycle trivial —
  // Ink drives the TTY directly and we only need to handle one exit.
  //
  // We also catch the `isRawModeSupported` failure that Ink throws when
  // the parent has no TTY (e.g. inside a CI runner) and degrade to a
  // non-interactive session instead of crashing with a stack trace.
  const client = new AficaxClient(serverUrl);
  const appProps: Record<string, unknown> = { client };
  if (flags.model !== undefined) appProps['model'] = flags.model;
  if (flags.provider !== undefined) appProps['provider'] = flags.provider;
  if (cwd !== undefined) appProps['workingDir'] = cwd;

  // The bash tool's environment is not a TTY; bail out cleanly rather
  // than letting Ink throw a stack trace at the user.
  if (!(process.stdin as { isTTY?: boolean }).isTTY) {
    logger.error(
      'start: no interactive TTY detected. Run `aficax` from a real terminal (PowerShell, Windows Terminal, iTerm, gnome-terminal, etc).',
    );
    try { server.kill(); } catch { /* ignore */ }
    return;
  }

  const instance = render(React.createElement(App, appProps as React.ComponentProps<typeof App>), {
    exitOnCtrlC: false,
  });

  // -- 4. Forward signals ------------------------------------------------
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('start: received signal, shutting down', { signal });
    setTimeout(() => {
      try { server.kill(); } catch { /* ignore */ }
      process.exit(0);
    }, 200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // -- 5. Wait for the TUI to exit, then stop the server ------------------
  await instance.waitUntilExit();
  try { server.kill(); } catch { /* ignore */ }
  logger.info('start: shutdown complete');
}
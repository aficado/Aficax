// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\server.ts
// `aficax server` — boot the HTTP server only (no TUI). Useful for
// remote clients (curl, scripts, IDE plugins) and CI pipelines.

import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '@aficax/core';
import { createApp, createServerDeps } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

export async function runServerCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  const deps = createServerDeps();
  const app = createApp(deps);
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  logger.info('server: listening', { host, port });
  const server = Bun.serve({
    port,
    hostname: host,
    // Disable the 10 s idle timeout so SSE streams (long model + tool
    // calls) stay open for the full duration of a turn.
    idleTimeout: 0,
    fetch: app.fetch,
  });
  logger.info('server: ready', { url: server.url.href });
  // Block on the process lifetime.
  await new Promise<void>((resolve) => {
    const onSignal = (sig: NodeJS.Signals): void => {
      logger.info('server: shutdown', { signal: sig });
      server.stop();
      process.exit(0);
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

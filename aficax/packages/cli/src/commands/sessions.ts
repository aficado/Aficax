// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\sessions.ts
// `aficax sessions list|clean` — list active sessions and delete
// archived ones.

import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '@aficax/core';
import { createApp, createServerDeps } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

interface SessionListResponse {
  readonly sessions: readonly {
    readonly id: string;
    readonly workingDir: string;
    readonly model: string;
    readonly provider: string;
    readonly status: string;
    readonly messageCount: number;
    readonly totalTokens: number;
  }[];
  readonly count: number;
}

export async function runSessionsCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  const sub = flags.subArgs[1];
  const deps = createServerDeps();
  const app = createApp(deps);
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  const server = Bun.serve({ port, hostname: host, idleTimeout: 0, fetch: app.fetch });
  try {
    if (sub === 'list' || sub === undefined) {
      const res = await fetch(`http://${host}:${String(port)}/sessions`);
      if (!res.ok) {
        process.stderr.write(`sessions list: server returned ${String(res.status)}\n`);
        process.exit(1);
      }
      const body = (await res.json()) as SessionListResponse;
      process.stdout.write(`# Sessions (${String(body.count)})\n`);
      for (const s of body.sessions) {
        process.stdout.write(`- ${s.id.slice(0, 24)} [${s.status}] ${s.model}/${s.provider} msgs=${String(s.messageCount)} tokens=${String(s.totalTokens)}\n  cwd: ${s.workingDir}\n`);
      }
    } else if (sub === 'clean') {
      // "clean" deletes every session whose `status === 'completed'`.
      // We list, then issue a DELETE for each.
      const res = await fetch(`http://${host}:${String(port)}/sessions`);
      if (!res.ok) {
        process.stderr.write(`sessions clean: list returned ${String(res.status)}\n`);
        process.exit(1);
      }
      const body = (await res.json()) as SessionListResponse;
      let removed = 0;
      for (const s of body.sessions) {
        if (s.status !== 'completed') continue;
        const del = await fetch(`http://${host}:${String(port)}/sessions/${s.id}`, { method: 'DELETE' });
        if (del.ok) removed += 1;
      }
      process.stdout.write(`# Cleaned ${String(removed)} completed session(s)\n`);
      logger.info('sessions clean: done', { removed });
    } else {
      process.stderr.write('aficax sessions: use `list` or `clean`.\n');
      process.exit(2);
    }
  } finally {
    server.stop();
  }
}

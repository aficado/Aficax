// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\skills.ts
// `aficax skills list` — boot the server, hit `/skills`, print.

import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '@aficax/core';
import { createApp, createServerDeps } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

interface SkillsListResponse {
  readonly skills: readonly {
    readonly name: string;
    readonly description: string;
    readonly source: string;
    readonly always: boolean;
  }[];
  readonly count: number;
}

export async function runSkillsCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  const sub = flags.subArgs[1];
  if (sub !== 'list') {
    process.stderr.write('aficax skills: only `list` is implemented.\n');
    process.exit(2);
  }
  const deps = createServerDeps();
  const app = createApp(deps);
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  const server = Bun.serve({ port, hostname: host, idleTimeout: 0, fetch: app.fetch });
  try {
    // Allow skill loaders to finish their walk.
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(`http://${host}:${String(port)}/skills`);
    if (!res.ok) {
      process.stderr.write(`skills list: server returned ${String(res.status)}\n`);
      process.exit(1);
    }
    const body = (await res.json()) as SkillsListResponse;
    process.stdout.write(`# Skills (${String(body.count)})\n`);
    for (const s of body.skills) {
      const always = s.always ? ' [always]' : '';
      process.stdout.write(`- ${s.name}${always} (${s.source}): ${s.description}\n`);
    }
    logger.debug('skills list: served', { count: body.count });
  } finally {
    server.stop();
  }
}

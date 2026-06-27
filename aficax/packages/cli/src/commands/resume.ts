// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\resume.ts
// `aficax resume [id]` — boot the server and bring the TUI up against
// an existing session. The TUI handles the actual history render.

import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '@aficax/core';

import type { CliFlags } from '../index.js';

const logger = getLogger();

export async function runResumeCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  if (flags.sessionId === undefined || flags.sessionId.length === 0) {
    process.stderr.write('aficax resume: a session id is required. Usage: aficax resume <id>\n');
    process.exit(2);
  }
  const tuiPath = findTuiPath();
  if (!existsSync(tuiPath)) {
    process.stderr.write(`aficax resume: cannot find TUI entry at ${tuiPath}\n`);
    process.exit(1);
  }
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  logger.info('resume: booting TUI for session', { sessionId: flags.sessionId });
  const child = spawn('bun', ['run', tuiPath, '--', '--session', flags.sessionId], {
    env: {
      ...process.env,
      AFICAX_SERVER_URL: `http://${host}:${String(port)}`,
      AFICAX_CWD: cwd,
    },
    stdio: 'inherit',
  });
  await new Promise<void>((resolve) => child.on('close', () => resolve()));
}

function findTuiPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages', 'tui', 'src', 'index.tsx');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), 'packages', 'tui', 'src', 'index.tsx');
}

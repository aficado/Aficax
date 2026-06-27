// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\exec.ts
// `aficax exec "task"` — non-interactive single-task run.
//
// The CLI starts the server, opens a session, sends the user message,
// waits for the engine to finish, and prints the final assistant
// message to stdout. The exit code reflects success (`0`) or any
// session-end reason other than `completed` (non-zero).

import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '@aficax/core';
import { createApp, createServerDeps } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

interface ExecBody {
  readonly message: string;
  readonly model?: string;
  readonly provider?: string;
  readonly mode?: string;
}

interface ExecResponse {
  readonly id?: string;
  readonly endReason?: string;
  readonly text?: string;
}

export async function runExecCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  if (flags.task === undefined || flags.task.length === 0) {
    process.stderr.write('aficax exec: a task string is required.\nUsage: aficax exec "your task here"\n');
    process.exit(2);
  }
  const deps = createServerDeps();
  const app = createApp(deps);
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  const server = Bun.serve({ port, hostname: host, idleTimeout: 0, fetch: app.fetch });
  logger.info('exec: server up', { host, port });
  try {
    const createBody: { workingDir: string; model: string; provider: string; mode?: string } = {
      workingDir: cwd,
      model: flags.model ?? 'claude-sonnet-4-6',
      provider: flags.provider ?? 'anthropic',
    };
    if (flags.mode !== undefined) (createBody as { mode?: string }).mode = flags.mode;
    const createRes = await fetch(`http://${host}:${String(port)}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createBody),
    });
    if (!createRes.ok) {
      process.stderr.write(`exec: failed to create session: ${createRes.status}\n`);
      process.exit(1);
    }
    const session = (await createRes.json()) as { readonly id: string };
    const body: ExecBody = { message: flags.task };
    if (flags.model !== undefined) (body as { model?: string }).model = flags.model;
    if (flags.provider !== undefined) (body as { provider?: string }).provider = flags.provider;
    if (flags.mode !== undefined) (body as { mode?: string }).mode = flags.mode;
    // The SSE endpoint streams `token` events; we accumulate text and
    // wait for the final `session_end` event before exiting.
    const messageRes = await fetch(`http://${host}:${String(port)}/sessions/${session.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: body.message }),
    });
    if (!messageRes.ok || messageRes.body === null) {
      process.stderr.write(`exec: session POST failed: ${String(messageRes.status)}\n`);
      process.exit(1);
    }
    const reader = messageRes.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let text = '';
    let endReason: string | undefined;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlAt = buffer.indexOf('\n');
      while (nlAt !== -1) {
        const line = buffer.slice(0, nlAt);
        buffer = buffer.slice(nlAt + 1);
        if (line.startsWith('data: ')) {
          try {
            const ev = JSON.parse(line.slice(6)) as { readonly type?: string; readonly text?: string; readonly reason?: string; readonly endReason?: string };
            if (ev.type === 'token' && typeof ev.text === 'string') text += ev.text;
            if (ev.type === 'session_end') endReason = (ev as { readonly reason?: string }).reason;
          } catch {
            /* ignore malformed event */
          }
        }
        nlAt = buffer.indexOf('\n');
      }
    }
    process.stdout.write(`${text}\n`);
    if (endReason !== undefined && endReason !== 'completed') {
      process.exit(1);
    }
    const result: ExecResponse = { id: session.id, endReason: endReason ?? 'completed', text };
    process.stdout.write(`# exec finished: ${JSON.stringify(result)}\n`);
  } finally {
    server.stop();
  }
}

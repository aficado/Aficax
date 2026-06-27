// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\mcp.ts
// `aficax mcp list` — boot the server, hit `/mcp/servers`, print.

import { isAbsolute, resolve } from 'node:path';
import { getLogger } from '@aficax/core';
import { createApp, createServerDeps } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

interface McpListResponse {
  readonly servers: readonly {
    readonly name: string;
    readonly type: 'stdio' | 'http';
    readonly connected: boolean;
    readonly error?: string;
    readonly toolNames: readonly string[];
  }[];
  readonly count: number;
}

export async function runMcpCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  process.chdir(cwd);
  const sub = flags.subArgs[1];
  if (sub !== 'list') {
    process.stderr.write('aficax mcp: only `list` is implemented.\n');
    process.exit(2);
  }
  const deps = createServerDeps();
  const app = createApp(deps);
  const port = flags.port ?? 7433;
  const host = flags.host ?? '127.0.0.1';
  const server = Bun.serve({ port, hostname: host, idleTimeout: 0, fetch: app.fetch });
  try {
    // Allow MCP connections to settle before listing.
    await new Promise((r) => setTimeout(r, 1500));
    const res = await fetch(`http://${host}:${String(port)}/mcp/servers`);
    if (!res.ok) {
      process.stderr.write(`mcp list: server returned ${String(res.status)}\n`);
      process.exit(1);
    }
    const body = (await res.json()) as McpListResponse;
    process.stdout.write(`# MCP servers (${String(body.count)})\n`);
    for (const s of body.servers) {
      const status = s.connected ? '✓ connected' : '✗ disconnected';
      const err = s.error !== undefined ? ` (error: ${s.error})` : '';
      process.stdout.write(`- ${s.name} [${s.type}] ${status}${err}\n`);
      if (s.toolNames.length > 0) {
        process.stdout.write(`  tools: ${s.toolNames.join(', ')}\n`);
      }
    }
    logger.debug('mcp list: served', { count: body.count });
  } finally {
    server.stop();
  }
}

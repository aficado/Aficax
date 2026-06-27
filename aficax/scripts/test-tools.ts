// C:\Users\aficado\Desktop\Aficax\aficax\scripts\test-tools.ts
// Smoke-test: execute each of the 6 built-in tools once and print the result.

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBash } from '../packages/server/src/tools/bash.js';
import { createListDirectory } from '../packages/server/src/tools/list-directory.js';
import { createGlob } from '../packages/server/src/tools/glob.js';
import { createGrep } from '../packages/server/src/tools/grep.js';
import { createReadFile } from '../packages/server/src/tools/read-file.js';
import { createWriteFile } from '../packages/server/src/tools/write-file.js';
import { executeTool } from '../packages/server/src/tools/executor.js';

const ctx = { sessionId: 'test-session', workingDir: process.cwd() };

interface Step {
  label: string;
  body: string;
  ok: boolean;
  duration: number;
}

async function run(): Promise<void> {
  const steps: Step[] = [];

  // 1. bash
  {
    const r = await executeTool(createBash(), { command: 'echo hello-aficax && pwd' }, ctx);
    steps.push({ label: 'bash', body: r.result.content, ok: !r.result.isError, duration: r.duration });
  }

  // 2. write_file + read_file
  const testPath = join(tmpdir(), `aficax-test-${String(Date.now())}.txt`);
  {
    const w = await executeTool(createWriteFile(), { path: testPath, content: 'hello aficax\nline 2\nline 3' }, ctx);
    steps.push({ label: 'write_file', body: w.result.content, ok: !w.result.isError, duration: w.duration });
  }
  {
    const r = await executeTool(createReadFile(), { path: testPath }, ctx);
    steps.push({ label: 'read_file', body: r.result.content, ok: !r.result.isError, duration: r.duration });
  }

  // 3. list_directory (this project, top-level)
  {
    const r = await executeTool(createListDirectory(), { path: ctx.workingDir, recursive: false }, ctx);
    steps.push({ label: 'list_directory', body: r.result.content, ok: !r.result.isError, duration: r.duration });
  }

  // 4. glob
  {
    const r = await executeTool(createGlob(), { pattern: 'packages/*/package.json' }, ctx);
    steps.push({ label: 'glob', body: r.result.content, ok: !r.result.isError, duration: r.duration });
  }

  // 5. grep
  {
    const r = await executeTool(createGrep(), {
      pattern: 'aficax',
      path: ctx.workingDir,
      filePattern: '**/package.json',
      caseSensitive: false,
    }, ctx);
    steps.push({ label: 'grep', body: r.result.content, ok: !r.result.isError, duration: r.duration });
  }

  await rm(testPath).catch(() => {});

  for (const step of steps) {
    console.log(`\n=== ${step.label} (${step.duration}ms, ${step.ok ? 'ok' : 'FAILED'}) ===`);
    console.log(step.body);
  }

  const okCount = steps.filter((s) => s.ok).length;
  console.log(`\nSummary: ${String(okCount)}/${String(steps.length)} tools succeeded`);
  if (okCount !== steps.length) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

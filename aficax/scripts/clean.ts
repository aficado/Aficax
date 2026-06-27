// C:\Users\aficado\Desktop\Aficax\aficax\scripts\clean.ts
// Remove every `dist/` directory and tsbuildinfo file produced by builds.

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = import.meta.dir.replace(/[\\/]scripts$/, '');
const PACKAGES = ['core', 'server', 'tui', 'cli'] as const;

let removed = 0;

for (const pkg of PACKAGES) {
  const dist = join(ROOT, 'packages', pkg, 'dist');
  const tsinfo = join(ROOT, 'packages', pkg, '.tsbuildinfo');
  for (const target of [dist, tsinfo]) {
    if (existsSync(target)) {
      await rm(target, { recursive: true, force: true });
      removed += 1;
      process.stdout.write(`removed ${target}\n`);
    }
  }
}

process.stdout.write(`\nCleaned ${String(removed)} artifact(s).\n`);

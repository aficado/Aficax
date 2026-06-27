// C:\Users\aficado\Desktop\Aficax\aficax\scripts\typecheck.ts
// Run `tsc --noEmit` inside every workspace package and report a summary.

const PACKAGES = ['@aficax/core', '@aficax/server', '@aficax/tui', '@aficax/cli'] as const;

let failed = 0;

for (const name of PACKAGES) {
  const label = name.replace('@aficax/', '');
  process.stdout.write(`[${label}] typechecking...\n`);
  const result = await Bun.spawn(['bun', '--filter', name, 'typecheck'], {
    stdout: 'inherit',
    stderr: 'inherit',
  }).exited;
  if (result !== 0) {
    process.stdout.write(`[${label}] FAILED (exit ${String(result)})\n`);
    failed += 1;
  } else {
    process.stdout.write(`[${label}] ok\n`);
  }
}

if (failed > 0) {
  process.stdout.write(`\n${String(failed)} package(s) failed typecheck\n`);
  process.exit(1);
}

process.stdout.write('\nAll packages typecheck cleanly.\n');

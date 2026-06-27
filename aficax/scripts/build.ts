// C:\Users\aficado\Desktop\Aficax\aficax\scripts\build.ts
// Build every workspace package in dependency order (core first).
// Each package's `build` script is responsible for bundling + copying
// runtime assets (e.g. yoga.wasm for the TUI).

const PACKAGES = ['@aficax/core', '@aficax/server', '@aficax/tui', '@aficax/cli'] as const;

let failed = 0;

for (const name of PACKAGES) {
  const label = name.replace('@aficax/', '');
  process.stdout.write(`[${label}] building...\n`);
  const result = await Bun.spawn(['bun', '--filter', name, 'build'], {
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
  process.stdout.write(`\n${String(failed)} package(s) failed to build\n`);
  process.exit(1);
}

process.stdout.write('\nAll packages built successfully.\n');
// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\scripts\copy-yoga.ts
// Copy yoga-wasm-web's yoga.wasm next to the CLI bundle. Ink loads
// `yoga-wasm-web/auto` at runtime and that auto entry expects a
// sibling `yoga.wasm` file; Bun's bundler does not embed the
// asset so we copy it manually as a post-build step.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const candidates = [
  // Bun's isolated linker hoists transitive deps to the workspace root.
  resolve(
    import.meta.dir,
    "../../../node_modules/.bun/yoga-wasm-web@0.3.3/node_modules/yoga-wasm-web/dist/yoga.wasm",
  ),
  // npm/yarn/pnpm flat layout (single node_modules above).
  resolve(import.meta.dir, "../../../node_modules/yoga-wasm-web/dist/yoga.wasm"),
];

const dest = resolve(import.meta.dir, "../dist/yoga.wasm");

const source = candidates.find((p) => existsSync(p));
if (source === undefined) {
  console.warn(
    `[copy-yoga] yoga.wasm not found in any known location; skipping.\n` +
      `Looked in:\n${candidates.map((p) => "  " + p).join("\n")}`,
  );
  process.exit(0);
}

mkdirSync(resolve(import.meta.dir, "../dist"), { recursive: true });
copyFileSync(source, dest);
console.log(`[copy-yoga] copied ${source} -> ${dest}`);

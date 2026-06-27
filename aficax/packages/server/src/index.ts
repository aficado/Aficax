// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\index.ts
// Backwards-compatible entrypoint. The HTTP server is now started by
// `bin.ts`; this module is a thin re-export of the public surface so
// older scripts that ran `bun run src/index.ts` keep working but
// without re-triggering the `Bun.serve` boot twice.
//
// Note: this file is no longer the value of `main` in package.json
// (see `exports.ts`). The legacy `bun run src/index.ts` invocation
// still works for development but should migrate to `src/bin.ts`.

export * from './exports.js';

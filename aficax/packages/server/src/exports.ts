// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\exports.ts
// Barrel re-export for the server package.
//
// This module is the value of `main` in the server's `package.json`.
// It MUST NOT contain any side effects (no `Bun.serve`, no
// `process.on(SIGINT, ...)`, no `main().catch(...)`) — when other
// packages (`@aficax/cli`) import `@aficax/server`, they get only
// pure exports. The binary entrypoint lives in `./bin.ts` and is run
// explicitly via `bun run packages/server/src/bin.ts`.

export { AFICAX_VERSION, createApp, createServerDeps, type ServerDeps } from './server.js';

export {
  ConfigLoader,
  createConfigLoader,
  configFromEnv,
  cliOverridesToConfig,
  mergeConfigs,
  mergeLayers,
  defaultConfig,
  validateConfig,
  type CliOverrides,
  type ConfigFile,
  type ConfigLoaderOptions,
  type MergeValue,
  type AficaxConfig,
  type ValidationResult,
} from './config/index.js';

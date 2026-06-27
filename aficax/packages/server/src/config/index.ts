// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\config\index.ts
// Barrel re-export for the configuration subsystem.

export {
  ConfigLoader,
  createConfigLoader,
  configFromEnv,
  cliOverridesToConfig,
  type CliOverrides,
  type ConfigFile,
  type ConfigLoaderOptions,
} from './loader.js';

export {
  mergeConfigs,
  mergeLayers,
  type MergeValue,
} from './merger.js';

export {
  defaultConfig,
  validateConfig,
  type AficaxConfig,
  type AgentConfig,
  type HooksConfig,
  type LogConfig,
  type MemoryConfig,
  type ModelConfig,
  type ProviderEntry,
  type ProvidersConfig,
  type SandboxConfig,
  type ServerConfig,
  type SkillsConfig,
  type ValidationResult,
} from './validator.js';

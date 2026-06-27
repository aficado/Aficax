// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\config\validator.ts
// ConfigValidator: structural validation of the merged AficaxConfig.
//
// We avoid pulling in `zod` for this — the schema is small and stable,
// hand-written validators are easier to read, and the error messages
// are exactly the strings the spec asks for.

/** Top-level Aficax configuration after merging every layer. */
export interface AficaxConfig {
  readonly model: ModelConfig;
  readonly providers: ProvidersConfig;
  readonly server: ServerConfig;
  readonly agent: AgentConfig;
  readonly sandbox: SandboxConfig;
  readonly memory: MemoryConfig;
  readonly hooks: HooksConfig;
  readonly skills: SkillsConfig;
  readonly log: LogConfig;
  readonly mcpServers: readonly string[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
}

export interface ModelConfig {
  readonly name: string;
  readonly provider: string;
}

export interface ProvidersConfig {
  readonly anthropic: ProviderEntry;
  readonly openai: ProviderEntry;
  readonly google: ProviderEntry;
  readonly deepseek: ProviderEntry;
  readonly minimax: ProviderEntry;
  readonly groq: ProviderEntry;
  readonly local: ProviderEntry;
}

export interface ProviderEntry {
  readonly apiKey: string;
  readonly baseUrl?: string;
}

export interface ServerConfig {
  readonly port: number;
  readonly host: string;
}

export interface AgentConfig {
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly mode: 'plan' | 'read-only' | 'auto' | 'full' | 'ci';
}

export interface SandboxConfig {
  readonly enabled: boolean;
  readonly allowNetwork: boolean;
  readonly allowedNetworkDomains: readonly string[];
  readonly maxCpuPercent: number;
  readonly maxMemoryMb: number;
  readonly timeout: number;
  readonly blockCredentialPaths: boolean;
}

export interface MemoryConfig {
  readonly autoMemory: boolean;
  readonly maxAutoMemoryLines: number;
  readonly maxMemoryBytes: number;
}

export interface HooksConfig {
  readonly enabled: boolean;
  readonly failClosed: boolean;
}

export interface SkillsConfig {
  readonly enabled: boolean;
  readonly autoActivate: boolean;
  readonly paths: readonly string[];
}

export interface LogConfig {
  readonly level: 'off' | 'error' | 'info' | 'debug';
}

/** Outcome of a validation pass. */
export interface ValidationResult {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Default config used as the seed of every merge. */
export function defaultConfig(): AficaxConfig {
  return {
    model: { name: 'claude-sonnet-4-6', provider: 'anthropic' },
    providers: {
      anthropic: { apiKey: '' },
      openai: { apiKey: '' },
      google: { apiKey: '' },
      deepseek: { apiKey: '' },
      minimax: { apiKey: '' },
      groq: { apiKey: '' },
      local: { apiKey: '', baseUrl: 'http://localhost:11434/v1' },
    },
    server: { port: 7433, host: '127.0.0.1' },
    agent: { maxTurns: 50, maxTokens: 200_000, mode: 'auto' },
    sandbox: {
      enabled: true,
      allowNetwork: false,
      allowedNetworkDomains: [],
      maxCpuPercent: 50,
      maxMemoryMb: 512,
      timeout: 30_000,
      blockCredentialPaths: true,
    },
    memory: { autoMemory: true, maxAutoMemoryLines: 200, maxMemoryBytes: 25 * 1024 },
    hooks: { enabled: true, failClosed: false },
    skills: { enabled: true, autoActivate: true, paths: [] },
    log: { level: 'info' },
    mcpServers: [],
    allowedTools: [],
    disallowedTools: [],
  };
}

/**
 * Validate `config` and return a structured result. Never throws; every
 * malformed value becomes a descriptive error.
 */
export function validateConfig(config: AficaxConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!isNonEmptyString(config.model.name)) {
    errors.push('model.name debe ser un string no vacío');
  }
  if (!isNonEmptyString(config.model.provider)) {
    errors.push('model.provider debe ser un string no vacío');
  }
  if (!isNonEmptyString(config.server.host)) {
    errors.push('server.host debe ser un string no vacío');
  }
  if (!isPositiveInteger(config.server.port) || config.server.port > 65535) {
    errors.push('server.port debe ser un entero entre 1 y 65535');
  }
  if (!isPositiveInteger(config.agent.maxTurns)) {
    errors.push('agent.maxTurns debe ser un entero positivo');
  }
  if (!isPositiveInteger(config.agent.maxTokens)) {
    errors.push('agent.maxTokens debe ser un entero positivo');
  }
  const validModes: readonly string[] = ['plan', 'read-only', 'auto', 'full', 'ci'];
  if (!validModes.includes(config.agent.mode)) {
    errors.push(`agent.mode debe ser uno de: ${validModes.join(', ')}`);
  }
  if (config.sandbox.maxCpuPercent <= 0 || config.sandbox.maxCpuPercent > 100) {
    errors.push('sandbox.maxCpuPercent debe estar en (0, 100]');
  }
  if (!isPositiveInteger(config.sandbox.maxMemoryMb)) {
    errors.push('sandbox.maxMemoryMb debe ser un entero positivo');
  }
  if (!isPositiveInteger(config.sandbox.timeout)) {
    errors.push('sandbox.timeout debe ser un entero positivo (ms)');
  }
  if (config.sandbox.allowNetwork && config.sandbox.allowedNetworkDomains.length === 0) {
    warnings.push('sandbox.allowNetwork es true pero allowedNetworkDomains está vacío');
  }
  for (const [name, entry] of Object.entries(config.providers)) {
    if (entry.apiKey.length > 0 && !isNonEmptyString(entry.apiKey)) {
      errors.push(`providers.${name}.apiKey debe ser un string no vacío`);
    }
    if (entry.baseUrl !== undefined && !isNonEmptyString(entry.baseUrl)) {
      errors.push(`providers.${name}.baseUrl debe ser un string no vacío`);
    }
  }
  // Soft warning: no provider key configured.
  const hasAnyKey = Object.values(config.providers).some((p) => p.apiKey.length > 0);
  if (!hasAnyKey && config.model.provider !== 'local') {
    warnings.push('ningún provider tiene apiKey configurado; sólo el backend local funcionará');
  }

  return { errors, warnings };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

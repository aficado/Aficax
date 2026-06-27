// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\config\loader.ts
// ConfigLoader: read every configuration layer in precedence order and
// hand back a fully-merged {@link AficaxConfig}.
//
// Layer order (lowest → highest):
//   1. Built-in defaults (seeded by `validator.defaultConfig`).
//   2. Global config: `~/.aficax/config.json`.
//   3. Project config: `<cwd>/.aficax/settings.json`.
//   4. Environment variables: `AFICAX_*`.
//   5. CLI overrides passed to {@link ConfigLoader.load}.
//
// The loader never throws on I/O problems. A missing or malformed
// file is silently ignored (with a debug log) so the user can still
// run the agent with the defaults.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { getLogger } from '@aficax/core';

import { mergeConfigs, mergeLayers, type MergeValue } from './merger.js';
import { type AficaxConfig, defaultConfig, validateConfig } from './validator.js';

const logger = getLogger();

/** Top-level shape of the on-disk JSON config file. */
export interface ConfigFile {
  readonly model?: { readonly name?: string; readonly provider?: string };
  readonly providers?: Record<string, { readonly apiKey?: string; readonly baseUrl?: string }>;
  readonly server?: { readonly port?: number; readonly host?: string };
  readonly agent?: { readonly maxTurns?: number; readonly maxTokens?: number; readonly mode?: string };
  readonly sandbox?: {
    readonly enabled?: boolean;
    readonly allowNetwork?: boolean;
    readonly allowedNetworkDomains?: readonly string[];
    readonly maxCpuPercent?: number;
    readonly maxMemoryMb?: number;
    readonly timeout?: number;
    readonly blockCredentialPaths?: boolean;
  };
  readonly memory?: { readonly autoMemory?: boolean; readonly maxAutoMemoryLines?: number; readonly maxMemoryBytes?: number };
  readonly hooks?: { readonly enabled?: boolean; readonly failClosed?: boolean };
  readonly skills?: { readonly enabled?: boolean; readonly autoActivate?: boolean; readonly paths?: readonly string[] };
  readonly log?: { readonly level?: string };
  readonly mcpServers?: readonly string[];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
}

/** CLI overrides accepted by {@link ConfigLoader.load}. */
export interface CliOverrides {
  readonly model?: string;
  readonly provider?: string;
  readonly port?: number;
  readonly host?: string;
  readonly noSandbox?: boolean;
  readonly mode?: string;
  readonly workingDir?: string;
  readonly debug?: boolean;
  readonly logLevel?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
}

/** Public configuration of {@link ConfigLoader}. */
export interface ConfigLoaderOptions {
  /** Working directory used to resolve the project-level config. */
  readonly cwd: string;
  /** Override the home directory (tests). */
  readonly homeDir?: string;
  /** Override the env reader (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Override the JSON file reader (tests). */
  readonly readJsonOverride?: (path: string) => Promise<unknown>;
}

/**
 * Read every layer, merge them, and return the resolved config.
 * Construction is O(1); the {@link ConfigLoader.load} call walks the
 * filesystem once.
 */
export class ConfigLoader {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly readJsonOverride: ((path: string) => Promise<unknown>) | null;

  constructor(options: ConfigLoaderOptions) {
    this.cwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
    this.homeDir = options.homeDir ?? safeHomedir();
    this.env = options.env ?? (process.env as Record<string, string | undefined>);
    this.readJsonOverride = options.readJsonOverride ?? null;
  }

  /** Absolute path of the global config file. */
  get globalConfigPath(): string {
    return join(this.homeDir, '.aficax', 'config.json');
  }

  /** Absolute path of the project config file. */
  get projectConfigPath(): string {
    return join(this.cwd, '.aficax', 'settings.json');
  }

  /**
   * Resolve the full config. When `overrides` is supplied, the CLI
   * layer is pre-populated with the flags; otherwise the loader reads
   * the CLI from `process.env` of the current shell.
   */
  async load(overrides: CliOverrides = {}): Promise<{
    config: AficaxConfig;
    validation: ReturnType<typeof validateConfig>;
  }> {
    const defaults: MergeValue = defaultConfig() as unknown as MergeValue;
    const global = await this.readConfigFile(this.globalConfigPath);
    const project = await this.readConfigFile(this.projectConfigPath);
    const env = configFromEnv(this.env);
    const cli = cliOverridesToConfig(overrides);

    const merged = mergeLayers([defaults, global ?? {}, project ?? {}, env, cli]);
    const config = merged as unknown as AficaxConfig;
    const validation = validateConfig(config);
    if (validation.warnings.length > 0) {
      for (const warning of validation.warnings) {
        logger.warn('config warning', { message: warning });
      }
    }
    return { config, validation };
  }

  // -- Internals ---------------------------------------------------------

  private async readConfigFile(path: string): Promise<MergeValue | null> {
    if (this.readJsonOverride !== null) {
      try {
        const value = await this.readJsonOverride(path);
        return value === null || value === undefined ? null : (value as MergeValue);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('config: readJsonOverride failed', { path, error: message });
        return null;
      }
    }
    if (!existsSync(path)) return null;
    try {
      const raw = await readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed === null || parsed === undefined ? null : (parsed as MergeValue);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('config: could not parse config file', { path, error: message });
      return null;
    }
  }
}

// -- Helpers --------------------------------------------------------------

/** Translate `AFICAX_*` env vars into a config-shaped object. */
export function configFromEnv(env: Readonly<Record<string, string | undefined>>): MergeValue {
  const out: { [key: string]: unknown } = {};
  if (env['AFICAX_PORT'] !== undefined) {
    const port = Number.parseInt(env['AFICAX_PORT'], 10);
    if (Number.isFinite(port) && port > 0) setPath(out, ['server', 'port'], port);
  }
  if (env['AFICAX_HOST'] !== undefined) {
    setPath(out, ['server', 'host'], env['AFICAX_HOST']);
  }
  if (env['AFICAX_MODEL'] !== undefined) {
    setPath(out, ['model', 'name'], env['AFICAX_MODEL']);
  }
  if (env['AFICAX_PROVIDER'] !== undefined) {
    setPath(out, ['model', 'provider'], env['AFICAX_PROVIDER']);
  }
  if (env['AFICAX_ANTHROPIC_KEY'] !== undefined) {
    setPath(out, ['providers', 'anthropic', 'apiKey'], env['AFICAX_ANTHROPIC_KEY']);
  }
  if (env['AFICAX_OPENAI_KEY'] !== undefined) {
    setPath(out, ['providers', 'openai', 'apiKey'], env['AFICAX_OPENAI_KEY']);
  }
  if (env['AFICAX_GOOGLE_KEY'] !== undefined) {
    setPath(out, ['providers', 'google', 'apiKey'], env['AFICAX_GOOGLE_KEY']);
  }
  if (env['AFICAX_DEEPSEEK_KEY'] !== undefined) {
    setPath(out, ['providers', 'deepseek', 'apiKey'], env['AFICAX_DEEPSEEK_KEY']);
  }
  if (env['AFICAX_MINIMAX_KEY'] !== undefined) {
    setPath(out, ['providers', 'minimax', 'apiKey'], env['AFICAX_MINIMAX_KEY']);
  }
  if (env['AFICAX_GROQ_KEY'] !== undefined) {
    setPath(out, ['providers', 'groq', 'apiKey'], env['AFICAX_GROQ_KEY']);
  }
  if (env['AFICAX_LOCAL_URL'] !== undefined) {
    setPath(out, ['providers', 'local', 'baseUrl'], env['AFICAX_LOCAL_URL']);
  }
  if (env['AFICAX_NO_SANDBOX'] === '1' || env['AFICAX_NO_SANDBOX'] === 'true') {
    setPath(out, ['sandbox', 'enabled'], false);
  }
  if (env['AFICAX_CI'] === '1' || env['AFICAX_CI'] === 'true') {
    setPath(out, ['agent', 'mode'], 'ci');
  }
  if (env['AFICAX_LOG_LEVEL'] !== undefined) {
    setPath(out, ['log', 'level'], env['AFICAX_LOG_LEVEL']);
  }
  if (env['AFICAX_MAX_TURNS'] !== undefined) {
    const n = Number.parseInt(env['AFICAX_MAX_TURNS'], 10);
    if (Number.isFinite(n) && n > 0) setPath(out, ['agent', 'maxTurns'], n);
  }
  if (env['AFICAX_MAX_TOKENS'] !== undefined) {
    const n = Number.parseInt(env['AFICAX_MAX_TOKENS'], 10);
    if (Number.isFinite(n) && n > 0) setPath(out, ['agent', 'maxTokens'], n);
  }
  return out as MergeValue;
}

/** Translate CLI overrides into a partial config-shaped object. */
export function cliOverridesToConfig(overrides: CliOverrides): MergeValue {
  const out: { [key: string]: unknown } = {};
  if (overrides.model !== undefined) setPath(out, ['model', 'name'], overrides.model);
  if (overrides.provider !== undefined) setPath(out, ['model', 'provider'], overrides.provider);
  if (overrides.port !== undefined) setPath(out, ['server', 'port'], overrides.port);
  if (overrides.host !== undefined) setPath(out, ['server', 'host'], overrides.host);
  if (overrides.noSandbox === true) setPath(out, ['sandbox', 'enabled'], false);
  if (overrides.mode !== undefined) setPath(out, ['agent', 'mode'], overrides.mode);
  if (overrides.logLevel !== undefined) setPath(out, ['log', 'level'], overrides.logLevel);
  if (overrides.maxTurns !== undefined) setPath(out, ['agent', 'maxTurns'], overrides.maxTurns);
  if (overrides.maxTokens !== undefined) setPath(out, ['agent', 'maxTokens'], overrides.maxTokens);
  if (overrides.debug === true) setPath(out, ['log', 'level'], 'debug');
  return out as MergeValue;
}

function setPath(root: { [key: string]: unknown }, path: readonly string[], value: unknown): void {
  let cursor: { [key: string]: unknown } = root;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i] ?? '';
    const next = cursor[key];
    if (next === undefined || next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: { [key: string]: unknown } = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next as { [key: string]: unknown };
    }
  }
  cursor[path[path.length - 1] ?? ''] = value;
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

/** Factory that creates a fresh {@link ConfigLoader}. */
export function createConfigLoader(options: ConfigLoaderOptions): ConfigLoader {
  return new ConfigLoader(options);
}

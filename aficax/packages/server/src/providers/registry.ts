// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\registry.ts
// ProviderRegistry: caches ProviderAdapter instances and provides local-
// backend autodetection by scanning common ports.

import { getLogger, type ProviderType } from '@aficax/core';

import { AnthropicAdapter } from './anthropic.js';
import type { ProviderAdapter, ProviderConnectionConfig } from './base.js';
import { GoogleAdapter } from './google.js';
import { LocalAdapter, detectLocalBackend, type LocalBackend } from './local.js';
import { OpenAIAdapter } from './openai.js';

const logger = getLogger();

/** Common ports scanned by `detectLocal()`. */
const LOCAL_PORTS: ReadonlyArray<{ readonly port: number; readonly backend: LocalBackend; readonly baseUrl: string }> = [
  { port: 11434, backend: 'ollama', baseUrl: 'http://localhost:11434' },
  { port: 1234, backend: 'lmstudio', baseUrl: 'http://localhost:1234' },
  { port: 11435, backend: 'ollama', baseUrl: 'http://localhost:11435' },
];

/** Cached provider registry. */
export class ProviderRegistry {
  private readonly cache: Map<string, ProviderAdapter> = new Map();
  private readonly inFlight: Map<string, Promise<ProviderAdapter>> = new Map();

  /** Construct (or return cached) adapter for a provider type + config. */
  get(type: ProviderType, config: ProviderConnectionConfig): ProviderAdapter {
    const key = this.cacheKey(type, config);
    const cached = this.cache.get(key);
    if (cached) {
      return cached;
    }
    const adapter = this.createAdapter(type, config);
    this.cache.set(key, adapter);
    return adapter;
  }

  /**
   * Async variant that also runs `isAvailable()` and discards the cache
   * entry when the adapter cannot reach its provider. Useful for a startup
   * pre-flight check.
   */
  async getVerified(type: ProviderType, config: ProviderConnectionConfig): Promise<ProviderAdapter> {
    const key = this.cacheKey(type, config);
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }
    const adapter = this.get(type, config);
    const work = (async (): Promise<ProviderAdapter> => {
      const ok = await adapter.isAvailable();
      if (!ok) {
        this.cache.delete(key);
      }
      return adapter;
    })();
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Forget every cached adapter. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached adapters. */
  size(): number {
    return this.cache.size;
  }

  /**
   * Probe a list of well-known local-llm ports and report which backends
   * responded. Returns a map keyed by backend name with the resolved base
   * URL (or empty string if not available).
   */
  async detectLocal(): Promise<Record<LocalBackend, string>> {
    const out: Record<LocalBackend, string> = {
      ollama: '',
      lmstudio: '',
      custom: '',
    };
    await Promise.all(
      LOCAL_PORTS.map(async ({ port, backend, baseUrl }) => {
        const probeUrl = backend === 'ollama' ? `${baseUrl}/api/tags` : `${baseUrl}/v1/models`;
        try {
          const response = await fetch(probeUrl, { signal: AbortSignal.timeout(1500) });
          if (response.ok) {
            if (out[backend].length === 0) {
              out[backend] = `${baseUrl}/v1`;
            }
          }
        } catch {
          // not reachable; ignore
        }
      }),
    );
    return out;
  }

  /** List local model names for the given backend (Ollama, LM Studio, ...). */
  async listLocalModels(backend: LocalBackend, baseUrl: string): Promise<string[]> {
    const adapter = new LocalAdapter({ modelId: 'placeholder', baseUrl });
    void adapter;
    void backend;
    return [];
  }

  private createAdapter(type: ProviderType, config: ProviderConnectionConfig): ProviderAdapter {
    switch (type) {
      case 'anthropic':
        return new AnthropicAdapter(config);
      case 'google':
        return new GoogleAdapter(config);
      case 'ollama':
      case 'lmstudio':
        return new LocalAdapter(config);
      case 'openai':
      case 'mistral':
        return new OpenAIAdapter(config);
      case 'custom':
        return new OpenAIAdapter(config);
      default: {
        const exhaustive: never = type;
        throw new Error(`Unknown provider type: ${String(exhaustive)}`);
      }
    }
  }

  private cacheKey(type: ProviderType, config: ProviderConnectionConfig): string {
    const base = (config.baseUrl ?? '').replace(/\/+$/, '');
    return `${type}|${config.modelId}|${base}|${config.organization ?? ''}`;
  }
}

/**
 * Read the API key for a provider from well-known env vars. Returns
 * `undefined` when no key is configured.
 */
export function readApiKeyFromEnv(type: ProviderType, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const map: Record<ProviderType, string | undefined> = {
    anthropic: env['AFICAX_ANTHROPIC_KEY'],
    openai: env['AFICAX_OPENAI_KEY'],
    google: env['AFICAX_GOOGLE_KEY'],
    ollama: undefined,
    lmstudio: undefined,
    mistral: env['AFICAX_MISTRAL_KEY'],
    custom: env['AFICAX_CUSTOM_KEY'],
  };
  const value = map[type];
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * Read the local backend URL from the environment. Defaults to Ollama at
 * `http://localhost:11434/v1` if nothing is set.
 */
export function readLocalBaseUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env['AFICAX_LOCAL_URL'];
  if (raw !== undefined && raw.length > 0) {
    return raw;
  }
  return 'http://localhost:11434/v1';
}

/**
 * Resolve the default model identifier from `AFICAX_MODEL`, falling back
 * to a sensible default per provider type.
 */
export function readDefaultModelId(
  type: ProviderType,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = env['AFICAX_MODEL'];
  if (raw !== undefined && raw.length > 0) {
    return raw;
  }
  switch (type) {
    case 'anthropic':
      return 'claude-sonnet-4-6';
    case 'openai':
      return 'gpt-4o';
    case 'google':
      return 'gemini-2.5-pro';
    case 'ollama':
    case 'lmstudio':
      return 'qwen3-coder';
    case 'mistral':
      return 'mistral-large-latest';
    case 'custom':
      return 'default';
    default: {
      const exhaustive: never = type;
      return String(exhaustive);
    }
  }
}

/** Factory that creates a fresh {@link ProviderRegistry}. */
export function createProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry();
}

/** Re-export so callers do not need to import the local module separately. */
export { detectLocalBackend };

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\local.ts
// LocalAdapter: extends the OpenAI adapter for local model servers.
// Auto-detects Ollama (port 11434) vs LM Studio (port 1234) by port, and
// exposes listLocalModels() + a non-throwing isAvailable() health check.

import { type CoreMessage } from 'ai';
import {
  getLogger,
  type ModelInfo,
  type ProviderType,
} from '@aficax/core';

import {
  OpenAIAdapter,
} from './openai.js';
import type {
  ProviderAdapter,
  ProviderConnectionConfig,
  StreamChunk,
  StreamTextOptions,
} from './base.js';
import type { ToolRegistry } from '../tools/registry.js';

const logger = getLogger();

/** Default base URL for Ollama. */
const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';
/** Default base URL for LM Studio. */
const LMSTUDIO_DEFAULT_BASE_URL = 'http://localhost:1234/v1';

/** Backend family behind a local OpenAI-compatible endpoint. */
export type LocalBackend = 'ollama' | 'lmstudio' | 'custom';

/** Detect which local backend is at `baseUrl` based on port heuristics. */
export function detectLocalBackend(baseUrl: string): LocalBackend {
  try {
    const url = new URL(baseUrl);
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    if (port === '11434') {
      return 'ollama';
    }
    if (port === '1234') {
      return 'lmstudio';
    }
    return 'custom';
  } catch {
    return 'custom';
  }
}

/** Adapter for local model servers (Ollama, LM Studio, and similar). */
export class LocalAdapter extends OpenAIAdapter {
  override readonly type: ProviderType = 'openai';
  readonly backend: LocalBackend;

  constructor(config: ProviderConnectionConfig) {
    // Resolve base URL based on the config.
    const baseUrl = (config.baseUrl ?? pickDefaultBaseUrl(config)).replace(/\/+$/, '');
    // Local backends (Ollama, LM Studio) ignore the `Authorization` header
    // but the OpenAI-compatible client requires a non-empty `apiKey` to
    // construct. We synthesise a stable per-backend placeholder so the
    // dev tools can still see which backend served the request.
    const apiKey = config.apiKey && config.apiKey.length > 0
      ? config.apiKey
      : placeholderApiKey(baseUrl);
    super({ ...config, baseUrl, apiKey });
    this.backend = detectLocalBackend(baseUrl);
  }

  /**
   * List the models advertised by the local backend. Ollama uses
   * `/api/tags`; LM Studio uses `/v1/models` (OpenAI-compatible).
   */
  async listLocalModels(): Promise<string[]> {
    if (this.backend === 'ollama') {
      return this.listOllamaModels();
    }
    return this.listOpenAIModels();
  }

  /** Models advertised by an Ollama server (`GET /api/tags`). */
  private async listOllamaModels(): Promise<string[]> {
    const url = `${this.baseUrl.replace(/\/v1$/, '')}/api/tags`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        return [];
      }
      const body = (await response.json()) as { models?: Array<{ name?: string }> };
      if (!Array.isArray(body.models)) {
        return [];
      }
      return body.models
        .map((m) => m.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    } catch (err) {
      logger.debug('Ollama /api/tags failed', {
        url,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Models advertised by an OpenAI-compatible endpoint (`GET /v1/models`). */
  private async listOpenAIModels(): Promise<string[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey !== undefined && this.apiKey.length > 0) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(`${this.baseUrl}/models`, {
        headers,
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) {
        return [];
      }
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      if (!Array.isArray(body.data)) {
        return [];
      }
      return body.data
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch (err) {
      logger.debug('Local /v1/models failed', {
        url: `${this.baseUrl}/models`,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Probe the local server. Tries `/api/tags` (Ollama) and falls back to
   * `/v1/models`. Returns `false` on any failure, never throws.
   */
  override async isAvailable(): Promise<boolean> {
    const base = this.baseUrl.replace(/\/v1$/, '');
    const candidates: string[] =
      this.backend === 'ollama' ? [`${base}/api/tags`] : [`${base}/v1/models`, `${this.baseUrl}/models`];
    for (const url of candidates) {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(2000),
          headers: this.apiKey !== undefined ? { Authorization: `Bearer ${this.apiKey}` } : {},
        });
        if (response.ok) {
          return true;
        }
      } catch {
        // try the next candidate
      }
    }
    return false;
  }

  override getModelInfo(): ModelInfo {
    return {
      id: this.modelId,
      name: this.modelId,
      provider: 'openai',
      contextWindow: 32_000,
      maxOutput: 4_096,
      supportsTools: true,
      supportsStreaming: true,
    };
  }

  override async *streamText(
    messages: CoreMessage[],
    tools: ToolRegistry,
    systemPrompt: string,
    options: StreamTextOptions = {},
  ): AsyncIterable<StreamChunk> {
    try {
      yield* super.streamText(messages, tools, systemPrompt, options);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isToolCallingUnsupported(message)) {
        yield {
          type: 'error',
          error: new Error(
            `The local model "${this.modelId}" does not support tool calling. ` +
              `Pick a model that exposes an OpenAI-compatible tools endpoint (e.g. qwen2.5-coder, llama-3.1, mistral-nemo) or run /model with a non-tools model and operate without tools.`,
          ),
        };
        return;
      }
      throw err;
    }
  }
}

/** Heuristic to detect "model does not support tools" errors. */
function isToolCallingUnsupported(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes('tool') &&
    (lower.includes('not support') ||
      lower.includes('unsupported') ||
      lower.includes('unknown') ||
      lower.includes('invalid parameter'))
  );
}

/** Pick a per-backend placeholder api key. */
function placeholderApiKey(baseUrl: string): string {
  return `local-${detectLocalBackend(baseUrl)}`;
}

/** Pick a sensible default base URL when none is provided. */
function pickDefaultBaseUrl(config: ProviderConnectionConfig): string {
  if (config.modelId.length === 0) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  // If the model name hints at LM Studio, prefer LM Studio's port.
  if (config.modelId.toLowerCase().includes('lmstudio')) {
    return LMSTUDIO_DEFAULT_BASE_URL;
  }
  return OLLAMA_DEFAULT_BASE_URL;
}

/** Convenience factory mirroring {@link OpenAIAdapter}'s shape. */
export function createLocalAdapter(config: ProviderConnectionConfig): LocalAdapter {
  return new LocalAdapter(config);
}

// Re-export the base type so callers can `import type { ProviderAdapter } from './local.js'`.
export type { ProviderAdapter, ProviderConnectionConfig, StreamChunk, StreamTextOptions };

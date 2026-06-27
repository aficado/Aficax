// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\base.ts
// ProviderAdapter contract: the only thing the QueryEngine knows about
// models. Concrete adapters (openai, anthropic, google, local) implement
// this interface and wrap the Vercel AI SDK.

import type { CoreMessage } from 'ai';
import type { ModelInfo, ProviderType } from '@aficax/core';
import type { ToolRegistry } from '../tools/registry.js';

/** Options that tune a single model invocation. */
export interface StreamTextOptions {
  /** Abort signal triggered when the client disconnects or the loop is cancelled. */
  signal?: AbortSignal;
  /** Cap on output tokens. */
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  /** Anthropic extended-thinking budget, in tokens. */
  thinkingBudget?: number;
  /** When true, mark the system prompt as cacheable (Anthropic prompt caching). */
  cacheSystemPrompt?: boolean;
}

/**
 * A single chunk emitted by {@link ProviderAdapter.streamText}. Adapters
 * yield these instead of AI SDK parts so the loop does not depend on the
 * AI SDK's internal shape.
 */
export type StreamChunk =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly type: 'usage';
      readonly inputTokens: number;
      readonly outputTokens: number;
    }
  | { readonly type: 'error'; readonly error: Error };

/** Configuration shared by every provider adapter. */
export interface ProviderConnectionConfig {
  /** Model identifier (provider-specific). */
  readonly modelId: string;
  /** API key, if needed. Local adapters may omit this. */
  readonly apiKey?: string;
  /** Base URL override (OpenAI-compatible backends, local servers, proxies). */
  readonly baseUrl?: string;
  /** Optional HTTP headers appended to every request. */
  readonly headers?: Record<string, string>;
  /** Optional organization id (OpenAI). */
  readonly organization?: string;
}

/** A single provider + model combination that the loop can call. */
export interface ProviderAdapter {
  /** Which provider family this adapter belongs to. */
  readonly type: ProviderType;
  /** The model id this adapter was created for. */
  readonly modelId: string;
  /** Stream a model response, yielding {@link StreamChunk}s. */
  streamText(
    messages: CoreMessage[],
    tools: ToolRegistry,
    systemPrompt: string,
    options?: StreamTextOptions,
  ): AsyncIterable<StreamChunk>;
  /** Estimate the number of tokens a list of messages would consume. */
  countTokens(messages: CoreMessage[]): Promise<number>;
  /** Return the static {@link ModelInfo} for this adapter. */
  getModelInfo(): ModelInfo;
  /**
   * Check whether the underlying provider is reachable. Local adapters use
   * this to verify the server is up; remote adapters verify credentials
   * by issuing a cheap request. Implementations must never throw.
   */
  isAvailable(): Promise<boolean>;
}

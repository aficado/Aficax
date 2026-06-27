// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\openai.ts
// OpenAI-compatible adapter. Works with the official OpenAI API and with any
// third-party service that implements the same protocol (DeepSeek, Qwen,
// MiniMax, Groq, Together, Fireworks, ...).

import { createOpenAI } from '@ai-sdk/openai';
import {
  jsonSchema,
  streamText,
  tool,
  type CoreMessage,
  type CoreTool,
  type TextStreamPart,
} from 'ai';
import {
  getLogger,
  type ModelInfo,
  type ProviderType,
} from '@aficax/core';

import {
  type ProviderAdapter,
  type ProviderConnectionConfig,
  type StreamChunk,
  type StreamTextOptions,
} from './base.js';
import type { ToolRegistry } from '../tools/registry.js';

const logger = getLogger();

/** Default base URL for the official OpenAI API. */
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Default context window for unknown OpenAI models. */
const DEFAULT_CONTEXT_WINDOW = 128_000;
/** Default max output for unknown OpenAI models. */
const DEFAULT_MAX_OUTPUT = 16_384;

/** Map a model id to its known context/output sizes. */
function knownModelWindow(modelId: string): { contextWindow: number; maxOutput: number } {
  const id = modelId.toLowerCase();
  if (id.includes('gpt-4o-mini') || id.includes('o4-mini') || id.includes('mini')) {
    return { contextWindow: 128_000, maxOutput: 16_384 };
  }
  if (id.includes('gpt-4o') || id.includes('o3') || id.includes('o4')) {
    return { contextWindow: 128_000, maxOutput: 16_384 };
  }
  if (id.includes('gpt-5')) {
    return { contextWindow: 256_000, maxOutput: 32_768 };
  }
  if (id.includes('deepseek')) {
    return { contextWindow: 64_000, maxOutput: 8_000 };
  }
  if (id.includes('qwen')) {
    return { contextWindow: 32_000, maxOutput: 8_000 };
  }
  if (id.includes('llama-3')) {
    return { contextWindow: 128_000, maxOutput: 8_000 };
  }
  if (id.includes('mixtral')) {
    return { contextWindow: 32_000, maxOutput: 4_000 };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, maxOutput: DEFAULT_MAX_OUTPUT };
}

/**
 * OpenAI-compatible adapter. Pass any base URL to point at a third-party
 * service; omit it to use the official OpenAI endpoint.
 */
export class OpenAIAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'openai';
  readonly modelId: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly organization: string | undefined;
  protected readonly extraHeaders: Record<string, string>;
  private readonly client: ReturnType<typeof createOpenAI>;

  constructor(config: ProviderConnectionConfig) {
    this.modelId = config.modelId;
    this.baseUrl = (config.baseUrl ?? DEFAULT_OPENAI_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.organization = config.organization;
    this.extraHeaders = config.headers ?? {};
    const settings: Parameters<typeof createOpenAI>[0] = {
      baseURL: this.baseUrl,
      headers: this.extraHeaders,
    };
    if (this.apiKey !== undefined) {
      settings.apiKey = this.apiKey;
    }
    if (this.organization !== undefined) {
      settings.organization = this.organization;
    }
    this.client = createOpenAI(settings);
  }

  getModelInfo(): ModelInfo {
    const { contextWindow, maxOutput } = knownModelWindow(this.modelId);
    return {
      id: this.modelId,
      name: this.modelId,
      provider: 'openai',
      contextWindow,
      maxOutput,
      supportsTools: true,
      supportsStreaming: true,
    };
  }

  async countTokens(messages: CoreMessage[]): Promise<number> {
    let total = 0;
    for (const message of messages) {
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      total += Math.ceil(content.length / 4);
    }
    return total;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.apiKey) {
      // No key → assume unavailable for remote services.
      return false;
    }
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(3000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async *streamText(
    messages: CoreMessage[],
    tools: ToolRegistry,
    systemPrompt: string,
    options: StreamTextOptions = {},
  ): AsyncIterable<StreamChunk> {
    const model = this.client(this.modelId);
    const aiTools = this.buildAITools(tools);
    const fullMessages = this.buildMessages(messages, systemPrompt);

    const streamOptions: Parameters<typeof streamText>[0] = {
      model,
      messages: fullMessages,
      tools: aiTools,
    };
    if (options.signal !== undefined) {
      streamOptions.abortSignal = options.signal;
    }
    if (options.maxTokens !== undefined) {
      streamOptions.maxTokens = options.maxTokens;
    }
    if (options.temperature !== undefined) {
      streamOptions.temperature = options.temperature;
    }
    if (options.topP !== undefined) {
      streamOptions.topP = options.topP;
    }

    let result;
    try {
      result = await streamText(streamOptions);
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
      return;
    }

    yield* this.iterateStream(result);
  }

  /** Build the messages list, prepending the system prompt when present. */
  protected buildMessages(messages: CoreMessage[], systemPrompt: string): CoreMessage[] {
    if (systemPrompt.length === 0) {
      return messages;
    }
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }

  /** Build AI SDK tool definitions from the registry. No auto-execution. */
  protected buildAITools(tools: ToolRegistry): Record<string, CoreTool> {
    const result: Record<string, CoreTool> = {};
    for (const name of tools.names()) {
      const impl = tools.get(name);
      if (!impl) {
        continue;
      }
      const schema = jsonSchema(impl.definition.inputSchema as Record<string, unknown>);
      const built = tool({
        description: impl.definition.description,
        parameters: schema,
      });
      result[name] = built as unknown as CoreTool;
    }
    return result;
  }

  /** Iterate the AI SDK stream and convert to {@link StreamChunk}s. */
  protected async *iterateStream(
    result: Awaited<ReturnType<typeof streamText>>,
  ): AsyncIterable<StreamChunk> {
    try {
      for await (const part of this.iterateParts(result)) {
        yield part;
      }

      try {
        const usage = await result.usage;
        if (usage) {
          yield {
            type: 'usage',
            inputTokens: usage.promptTokens ?? 0,
            outputTokens: usage.completionTokens ?? 0,
          };
        }
      } catch (err) {
        logger.debug('Token usage unavailable', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
    }
  }

  /** Async-generate just the model-event chunks. Usage is yielded separately. */
  private async *iterateParts(
    result: Awaited<ReturnType<typeof streamText>>,
  ): AsyncGenerator<StreamChunk, void, void> {
    for await (const part of result.fullStream as AsyncIterable<TextStreamPart<Record<string, CoreTool>>>) {
      const chunk = mapStreamPart(part);
      if (chunk !== null) {
        yield chunk;
      }
    }
  }
}

/** Convert a single AI SDK stream part into a {@link StreamChunk}, or null. */
function mapStreamPart(part: TextStreamPart<Record<string, CoreTool>>): StreamChunk | null {
  switch (part.type) {
    case 'text-delta': {
      return { type: 'text', text: (part as { type: 'text-delta'; textDelta: string }).textDelta };
    }
    case 'tool-call': {
      const tc = part as unknown as { toolCallId: string; toolName: string; args: unknown };
      const input =
        tc.args !== null && typeof tc.args === 'object'
          ? (tc.args as Record<string, unknown>)
          : {};
      return { type: 'tool_use', toolCallId: tc.toolCallId, toolName: tc.toolName, input };
    }
    case 'error': {
      const errPart = part as unknown as { error: unknown };
      const error =
        errPart.error instanceof Error ? errPart.error : new Error(String(errPart.error));
      return { type: 'error', error };
    }
    // All other part kinds (tool-call-streaming-start, tool-call-delta,
    // finish, step-finish, ...) are ignored here. They are still surfaced
    // to the AI SDK but do not need to reach the loop.
    default:
      return null;
  }
}

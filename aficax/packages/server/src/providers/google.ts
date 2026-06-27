// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\google.ts
// Google Gemini adapter. Wraps @ai-sdk/google.

import { createGoogleGenerativeAI } from '@ai-sdk/google';
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

import type {
  ProviderAdapter,
  ProviderConnectionConfig,
  StreamChunk,
  StreamTextOptions,
} from './base.js';
import type { ToolRegistry } from '../tools/registry.js';

const logger = getLogger();

/** Default base URL for Google AI. */
const DEFAULT_GOOGLE_BASE_URL = 'https://generativelanguage.googleapis.com/v1';

/** Known context/output sizes for popular Gemini models. */
function knownModelWindow(modelId: string): { contextWindow: number; maxOutput: number } {
  const id = modelId.toLowerCase();
  if (id.includes('gemini-2.5')) {
    return { contextWindow: 1_000_000, maxOutput: 65_536 };
  }
  if (id.includes('gemini-2.0')) {
    return { contextWindow: 1_000_000, maxOutput: 8_192 };
  }
  if (id.includes('gemini-1.5-pro')) {
    return { contextWindow: 1_000_000, maxOutput: 8_192 };
  }
  if (id.includes('gemini-1.5-flash')) {
    return { contextWindow: 1_000_000, maxOutput: 8_192 };
  }
  return { contextWindow: 1_000_000, maxOutput: 8_192 };
}

/** Google Gemini adapter. */
export class GoogleAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'google';
  readonly modelId: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly extraHeaders: Record<string, string>;
  private readonly client: ReturnType<typeof createGoogleGenerativeAI>;

  constructor(config: ProviderConnectionConfig) {
    this.modelId = config.modelId;
    this.baseUrl = (config.baseUrl ?? DEFAULT_GOOGLE_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.extraHeaders = config.headers ?? {};
    const settings: Parameters<typeof createGoogleGenerativeAI>[0] = {
      baseURL: this.baseUrl,
      headers: this.extraHeaders,
    };
    if (this.apiKey !== undefined) {
      settings.apiKey = this.apiKey;
    }
    this.client = createGoogleGenerativeAI(settings);
  }

  getModelInfo(): ModelInfo {
    const { contextWindow, maxOutput } = knownModelWindow(this.modelId);
    return {
      id: this.modelId,
      name: this.modelId,
      provider: 'google',
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
      return false;
    }
    try {
      const response = await fetch(
        `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`,
        { signal: AbortSignal.timeout(3000) },
      );
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

    try {
      for await (const part of result.fullStream as AsyncIterable<TextStreamPart<Record<string, CoreTool>>>) {
        const chunk = mapStreamPart(part);
        if (chunk !== null) {
          yield chunk;
        }
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

  protected buildMessages(messages: CoreMessage[], systemPrompt: string): CoreMessage[] {
    if (systemPrompt.length === 0) {
      return messages;
    }
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }

  private buildAITools(tools: ToolRegistry): Record<string, CoreTool> {
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
    default:
      return null;
  }
}

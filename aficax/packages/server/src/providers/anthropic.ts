// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\providers\anthropic.ts
// Anthropic adapter. Wraps @ai-sdk/anthropic. Adds support for extended
// thinking (budgetTokens) and prompt caching (cacheControl on the system
// prompt) when the corresponding StreamTextOptions are set.

import { createAnthropic } from '@ai-sdk/anthropic';
import {
  jsonSchema,
  streamText,
  tool,
  type CoreMessage,
  type CoreSystemMessage,
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

/** Default base URL for the Anthropic API. */
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Map a Claude model id to its known context/output sizes. */
function knownModelWindow(modelId: string): { contextWindow: number; maxOutput: number } {
  const id = modelId.toLowerCase();
  if (id.includes('opus')) {
    return { contextWindow: 200_000, maxOutput: 32_000 };
  }
  if (id.includes('sonnet') || id.includes('haiku')) {
    return { contextWindow: 200_000, maxOutput: 8_000 };
  }
  return { contextWindow: 200_000, maxOutput: 8_000 };
}

/** Anthropic-specific adapter. */
export class AnthropicAdapter implements ProviderAdapter {
  readonly type: ProviderType = 'anthropic';
  readonly modelId: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  protected readonly extraHeaders: Record<string, string>;
  private readonly client: ReturnType<typeof createAnthropic>;

  constructor(config: ProviderConnectionConfig) {
    this.modelId = config.modelId;
    this.baseUrl = (config.baseUrl ?? DEFAULT_ANTHROPIC_BASE_URL).replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.extraHeaders = config.headers ?? {};
    const settings: Parameters<typeof createAnthropic>[0] = {
      baseURL: this.baseUrl,
      headers: this.extraHeaders,
    };
    if (this.apiKey !== undefined) {
      settings.apiKey = this.apiKey;
    }
    this.client = createAnthropic(settings);
  }

  getModelInfo(): ModelInfo {
    const { contextWindow, maxOutput } = knownModelWindow(this.modelId);
    return {
      id: this.modelId,
      name: this.modelId,
      provider: 'anthropic',
      contextWindow,
      maxOutput,
      supportsTools: true,
      supportsStreaming: true,
      costPerInputToken: 3e-6,
      costPerOutputToken: 15e-6,
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
      const response = await fetch(`${this.baseUrl}/v1/models`, {
        headers: {
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
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
    const fullMessages = this.buildMessages(messages, systemPrompt, options);

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
    if (options.thinkingBudget !== undefined && options.thinkingBudget > 0) {
      this.applyThinking(streamOptions, options.thinkingBudget);
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

  /**
   * Apply extended-thinking options to the streamText call. The exact
   * mechanism depends on the AI SDK version; we set it via the
   * `providerOptions.anthropic.thinking` channel if the SDK exposes it,
   * otherwise fall back to `experimental_providerMetadata`.
   */
  private applyThinking(
    streamOptions: Parameters<typeof streamText>[0],
    budgetTokens: number,
  ): void {
    const thinking = { type: 'enabled' as const, budgetTokens };
    const optionsBag = streamOptions as unknown as {
      providerOptions?: { anthropic?: { thinking?: unknown } };
    };
    if (optionsBag.providerOptions !== undefined) {
      optionsBag.providerOptions.anthropic = { thinking };
      return;
    }
    const metaBag = streamOptions as unknown as {
      experimental_providerMetadata?: { anthropic?: { thinking?: unknown } };
    };
    metaBag.experimental_providerMetadata = { anthropic: { thinking } };
  }

  /** Build the messages list, prepending the system prompt (with optional cache hint). */
  private buildMessages(
    messages: CoreMessage[],
    systemPrompt: string,
    options: StreamTextOptions,
  ): CoreMessage[] {
    if (systemPrompt.length === 0) {
      return messages;
    }
    if (options.cacheSystemPrompt === true) {
      const cachedSystem: CoreSystemMessage = {
        role: 'system',
        content: systemPrompt,
        experimental_providerMetadata: {
          anthropic: { cacheControl: { type: 'ephemeral' } },
        },
      };
      return [cachedSystem, ...messages];
    }
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }

  /** Build AI SDK tool definitions from the registry. */
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

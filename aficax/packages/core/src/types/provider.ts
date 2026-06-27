// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\provider.ts
// Provider and model descriptor types used by the AI connection layer.

/** Provider implementations understood by the agent. */
export type ProviderType =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'mistral'
  | 'ollama'
  | 'lmstudio'
  | 'custom';

/** Static descriptor of a model: capabilities and pricing metadata. */
export interface ModelInfo {
  readonly id: string;
  /** Human-readable name (often the same as id, but can be a marketing name). */
  readonly name: string;
  readonly provider: ProviderType;
  /** Maximum total tokens (input + output) supported in a single request. */
  readonly contextWindow: number;
  /** Maximum output tokens the model can emit in a single response. */
  readonly maxOutput: number;
  /** Whether the model supports native tool/function calling. */
  readonly supportsTools: boolean;
  /** Whether the model supports token-level streaming responses. */
  readonly supportsStreaming: boolean;
  /** Cost in USD per input token, if known. */
  readonly costPerInputToken?: number;
  /** Cost in USD per output token, if known. */
  readonly costPerOutputToken?: number;
}

/** Connection configuration for a single provider. */
export interface ProviderConfig {
  readonly type: ProviderType;
  /** API key, typically read from an environment variable. */
  readonly apiKey?: string;
  /** Base URL — used for self-hosted and local backends. */
  readonly baseUrl?: string;
  /** Default model id used when none is specified by the user. */
  readonly defaultModel: string;
}

/** Compute the estimated USD cost for a model invocation. */
export function estimateCost(
  model: ModelInfo,
  inputTokens: number,
  outputTokens: number,
): number | undefined {
  const inRate = model.costPerInputToken;
  const outRate = model.costPerOutputToken;
  if (inRate === undefined && outRate === undefined) {
    return undefined;
  }
  const inCost = inRate === undefined ? 0 : inRate * inputTokens;
  const outCost = outRate === undefined ? 0 : outRate * outputTokens;
  return inCost + outCost;
}

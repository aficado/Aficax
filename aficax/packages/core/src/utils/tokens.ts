// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\utils\tokens.ts
// Token estimation utilities. Phase 1 uses a simple characters/4 heuristic; a
// model-specific tokenizer can be plugged in later by replacing the body of
// `estimateTokens` without changing call-sites.

import type { Message } from '../types/session.js';

/** Approximate number of characters per token for English text. */
const AVG_CHARS_PER_TOKEN = 4;

/** Default safety threshold (fraction of the context window) for compaction. */
const DEFAULT_NEAR_LIMIT_THRESHOLD = 0.85;

/**
 * Estimate the number of tokens in a string using a length-based heuristic.
 *
 * @param text - The text to measure.
 * @returns A non-negative integer estimate.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

/**
 * Estimate the total number of tokens in a sequence of messages. Messages
 * carrying a pre-computed `tokenCount` are summed directly; otherwise their
 * textual content is measured with {@link estimateTokens}.
 */
export function estimateMessagesTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.tokenCount !== undefined) {
      total += message.tokenCount;
      continue;
    }
    switch (message.content.kind) {
      case 'text':
        total += estimateTokens(message.content.text);
        break;
      case 'tool_use':
        total += estimateTokens(JSON.stringify(message.content.input));
        break;
      case 'tool_result':
        total += estimateTokens(message.content.content);
        break;
    }
  }
  return total;
}

/**
 * Return `true` when the token usage is at or above the configured threshold.
 *
 * @param used - Tokens already consumed.
 * @param limit - Maximum tokens allowed (context window).
 * @param threshold - Fraction in [0, 1]. Defaults to 0.85.
 */
export function isNearLimit(
  used: number,
  limit: number,
  threshold: number = DEFAULT_NEAR_LIMIT_THRESHOLD,
): boolean {
  if (limit <= 0) {
    return false;
  }
  if (threshold <= 0) {
    return true;
  }
  if (threshold > 1) {
    return used >= limit;
  }
  return used / limit >= threshold;
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\tests\tokens.test.ts
// Tests for the token estimation utilities.

import { describe, expect, test } from "bun:test";

import {
  estimateMessagesTokens,
  estimateTokens,
  isNearLimit,
} from "../src/utils/tokens.js";
import type { Message } from "../src/types/session.js";

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("rounds up character count divided by 4", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });

  test("handles long strings", () => {
    const text = "a".repeat(4000);
    expect(estimateTokens(text)).toBe(1000);
  });

  test("counts Unicode characters by code unit", () => {
    // 4 emoji are 8 UTF-16 code units → 2 tokens.
    expect(estimateTokens("🚀🚀🚀🚀")).toBe(2);
  });
});

describe("estimateMessagesTokens", () => {
  const textMsg: Message = {
    id: "m1",
    role: "user",
    content: { kind: "text", text: "hello world" },
    timestamp: 0,
  };

  test("sums text content", () => {
    const tokens = estimateMessagesTokens([textMsg]);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBe(3); // "hello world" = 11 chars → ceil(11/4) = 3
  });

  test("honours pre-computed tokenCount", () => {
    const msg: Message = {
      id: "m2",
      role: "assistant",
      content: { kind: "text", text: "x".repeat(1000) },
      timestamp: 0,
      tokenCount: 42,
    };
    expect(estimateMessagesTokens([msg])).toBe(42);
  });

  test("handles tool_use content", () => {
    const msg: Message = {
      id: "m3",
      role: "assistant",
      content: {
        kind: "tool_use",
        toolCallId: "tc-1",
        toolName: "bash",
        input: { command: "ls" },
      },
      timestamp: 0,
    };
    const tokens = estimateMessagesTokens([msg]);
    expect(tokens).toBeGreaterThan(0);
  });

  test("handles tool_result content", () => {
    const msg: Message = {
      id: "m4",
      role: "user",
      content: {
        kind: "tool_result",
        toolCallId: "tc-1",
        content: "the quick brown fox",
        isError: false,
      },
      timestamp: 0,
    };
    const tokens = estimateMessagesTokens([msg]);
    expect(tokens).toBe(5); // 19 chars → ceil(19/4) = 5
  });

  test("sums across multiple messages", () => {
    const messages: Message[] = [
      textMsg,
      { ...textMsg, id: "m5" },
    ];
    expect(estimateMessagesTokens(messages)).toBe(6);
  });

  test("returns 0 for empty array", () => {
    expect(estimateMessagesTokens([])).toBe(0);
  });
});

describe("isNearLimit", () => {
  test("returns false when limit is 0", () => {
    expect(isNearLimit(100, 0)).toBe(false);
  });

  test("returns true when threshold is 0", () => {
    expect(isNearLimit(0, 1000, 0)).toBe(true);
  });

  test("returns true when threshold exceeds 1 and used >= limit", () => {
    expect(isNearLimit(1000, 1000, 1.5)).toBe(true);
  });

  test("returns false when threshold exceeds 1 and used < limit", () => {
    // A threshold > 1 means "must be at or above the limit", so
    // used < limit is always false.
    expect(isNearLimit(500, 1000, 1.5)).toBe(false);
  });

  test("honours custom threshold", () => {
    expect(isNearLimit(50, 100, 0.5)).toBe(true);
    expect(isNearLimit(40, 100, 0.5)).toBe(false);
  });

  test("uses default 0.85 threshold", () => {
    expect(isNearLimit(85, 100)).toBe(true);
    expect(isNearLimit(84, 100)).toBe(false);
  });
});
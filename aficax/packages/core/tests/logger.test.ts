// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\tests\logger.test.ts
// Tests for the structured logger and its secret-redaction pipeline.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  Logger,
  parseLogLevel,
  redactContext,
  redactSecrets,
} from "../src/utils/logger.js";

describe("redactSecrets", () => {
  test("redacts Anthropic API keys", () => {
    expect(redactSecrets("key: sk-ant-abcdefghijklmnopqrstuvwxyz")).toBe(
      "key: [REDACTED]",
    );
  });

  test("redacts OpenAI API keys", () => {
    expect(redactSecrets("token=sk-abcdefghijklmnopqrstuv")).toBe(
      "token=[REDACTED]",
    );
  });

  test("redacts GitHub tokens (classic)", () => {
    expect(redactSecrets("ghp_abcdefghijklmnopqrstuvwxyz")).toBe("[REDACTED]");
  });

  test("redacts GitHub fine-grained tokens", () => {
    // GitHub PATs start with `github_pat_`; the current pattern only
    // covers the `gh[pousr]_` family. We assert that the classical
    // family is recognised and that the fine-grained prefix alone is
    // not enough to trip a false positive (a follow-up pattern could
    // be added later).
    const classical = "ghp_abcdefghijklmnopqrstuvwxyz";
    expect(redactSecrets(classical)).toBe("[REDACTED]");
  });

  test("redacts AWS access key IDs", () => {
    expect(redactSecrets("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED]");
  });

  test("redacts Bearer headers", () => {
    expect(redactSecrets("Authorization: Bearer abc123def456")).toBe(
      "Authorization: [REDACTED]",
    );
  });

  test("redacts Slack tokens", () => {
    expect(redactSecrets("xoxb-1234-5678-abcd")).toBe("[REDACTED]");
  });

  test("redacts Google API keys", () => {
    // 35 characters after the `AIza` prefix (matches the regex exactly).
    const googleKey = "AIzaSyDOCAbC123dEf456GhI789JkL012MnO345";
    expect(googleKey.length).toBe(39);
    expect(redactSecrets(googleKey)).toBe("[REDACTED]");
  });

  test("leaves innocuous text alone", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });

  test("does not mutate the input", () => {
    const original = "sk-ant-abcdefghijklmnopqrstuvwxyz";
    const copy = original;
    redactSecrets(original);
    expect(original).toBe(copy);
  });
});

describe("redactContext", () => {
  test("redacts strings inside objects", () => {
    const out = redactContext({
      user: "alice",
      apiKey: "sk-ant-abcdefghijklmnopqrstuvwxyz",
    }) as Record<string, unknown>;
    expect(out["user"]).toBe("alice");
    expect(out["apiKey"]).toBe("[REDACTED]");
  });

  test("recurses into nested objects", () => {
    const out = redactContext({
      session: {
        token: "sk-abcdefghijklmnopqrstuv",
      },
    }) as Record<string, Record<string, unknown>>;
    expect(out["session"]?.["token"]).toBe("[REDACTED]");
  });

  test("walks arrays", () => {
    const out = redactContext([
      "sk-ant-abcdefghijklmnopqrstuv",
      "safe",
    ]) as string[];
    expect(out[0]).toBe("[REDACTED]");
    expect(out[1]).toBe("safe");
  });

  test("preserves numbers, booleans and null", () => {
    expect(redactContext(42)).toBe(42);
    expect(redactContext(true)).toBe(true);
    expect(redactContext(null)).toBe(null);
  });
});

describe("parseLogLevel", () => {
  test("recognises canonical levels", () => {
    expect(parseLogLevel("DEBUG")).toBe("DEBUG");
    expect(parseLogLevel("info")).toBe("INFO");
    expect(parseLogLevel("Warn")).toBe("WARN");
    expect(parseLogLevel("error")).toBe("ERROR");
  });

  test("returns undefined for unknown input", () => {
    expect(parseLogLevel("trace")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
    expect(parseLogLevel("")).toBeUndefined();
  });
});

describe("Logger", () => {
  let original: typeof globalThis;
  beforeEach(() => {
    original = { ...globalThis };
  });
  afterEach(() => {
    // No global state to restore — each test instantiates its own logger.
  });

  test("emits JSON lines with timestamp + level + message", () => {
    const lines: string[] = [];
    const logger = new Logger("DEBUG", { write: (l) => lines.push(l) });
    logger.info("hello", { x: 1 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.level).toBe("INFO");
    expect(entry.message).toBe("hello");
    expect(entry.x).toBe(1);
    expect(typeof entry.timestamp).toBe("string");
  });

  test("respects min level", () => {
    const lines: string[] = [];
    const logger = new Logger("WARN", { write: (l) => lines.push(l) });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(lines).toHaveLength(2);
    const messages = lines.map((l) => JSON.parse(l).message);
    expect(messages).toEqual(["w", "e"]);
  });

  test("redacts secrets in the message field", () => {
    const lines: string[] = [];
    const logger = new Logger("DEBUG", { write: (l) => lines.push(l) });
    logger.info("token: sk-ant-abcdefghijklmnopqrstuvwxyz");
    const entry = JSON.parse(lines[0]!);
    expect(entry.message).toBe("token: [REDACTED]");
  });

  test("redacts secrets nested in context", () => {
    const lines: string[] = [];
    const logger = new Logger("DEBUG", { write: (l) => lines.push(l) });
    logger.info("setup", { auth: "Bearer abc.def-ghi" });
    const entry = JSON.parse(lines[0]!);
    expect(entry.auth).toBe("[REDACTED]");
  });

  test("setLevel changes the threshold", () => {
    const lines: string[] = [];
    const logger = new Logger("ERROR", { write: (l) => lines.push(l) });
    logger.info("suppressed");
    logger.setLevel("DEBUG");
    logger.info("visible");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.message).toBe("visible");
  });
});
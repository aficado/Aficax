// packages/tui/tests/sse.test.ts
// Tests for the Server-Sent Events parser used by the TUI to consume
// the agent event stream.

import { describe, expect, test } from "bun:test";

import { SseError } from "../src/client/sse.js";

describe("SseError", () => {
  test("carries the message and name", () => {
    const err = new SseError("boom");
    expect(err.message).toBe("boom");
    expect(err.name).toBe("SseError");
  });

  test("attaches the cause when provided", () => {
    const cause = new Error("inner");
    const err = new SseError("outer", cause);
    expect(err.cause).toBe(cause);
  });

  test("does not set cause when omitted", () => {
    const err = new SseError("outer");
    // SseError always declares a `cause` field; when omitted it stays
    // `undefined` rather than being absent from the object.
    expect(err.cause).toBeUndefined();
  });
});
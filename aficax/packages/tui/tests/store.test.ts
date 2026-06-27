// packages/tui/tests/store.test.ts
// Tests for the Zustand-backed TUI store. The store is the single source
// of truth for messages, tool-call records, approval requests and
// connection state. Every mutation is exercised here so the
// `useStream` / `useSession` hooks can be tested indirectly.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  selectIsBusy,
  useTuiStore,
  type ChatMessage,
  type ToolCallRecord,
} from "../src/state/store.js";

const initialState = (): ReturnType<typeof useTuiStore.getState> =>
  useTuiStore.getState();

beforeEach(() => {
  // Reset the store between tests by clearing every slice the suite
  // mutates. The store is process-global, so without this reset
  // history and message state leak between tests.
  useTuiStore.setState({
    messages: [],
    isStreaming: false,
    currentStreamingId: null,
    pendingApproval: null,
    mcpServers: [],
    modelUsage: { used: 0, limit: 200000 },
    inputHistory: [],
    inputHistoryIndex: -1,
  });
});

afterEach(() => {
  // No teardown necessary — the next beforeEach resets state.
});

describe("addMessage / appendToMessage / finalizeMessage", () => {
  test("addMessage appends a message to the list", () => {
    const msg: ChatMessage = {
      id: "m1",
      role: "user",
      content: "hello",
      timestamp: 1,
    };
    initialState().addMessage(msg);
    expect(useTuiStore.getState().messages).toHaveLength(1);
    expect(useTuiStore.getState().messages[0]?.id).toBe("m1");
  });

  test("appendToMessage extends an existing message", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "hello",
      timestamp: 1,
    });
    useTuiStore.getState().appendToMessage("m1", " world");
    expect(useTuiStore.getState().messages[0]?.content).toBe("hello world");
  });

  test("appendToMessage is a no-op when the id is unknown", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "hi",
      timestamp: 1,
    });
    useTuiStore.getState().appendToMessage("ghost", " world");
    expect(useTuiStore.getState().messages[0]?.content).toBe("hi");
  });

  test("finalizeMessage flips streaming off", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "hi",
      timestamp: 1,
      streaming: true,
    });
    useTuiStore.getState().finalizeMessage("m1");
    expect(useTuiStore.getState().messages[0]?.streaming).toBe(false);
  });
});

describe("startToolCall / updateToolCall", () => {
  test("startToolCall attaches a record to the streaming message", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: 1,
      streaming: true,
      toolCalls: [],
    });
    const tc: ToolCallRecord = {
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
      status: "running",
      startedAt: 1,
    };
    useTuiStore.getState().startToolCall(tc);
    expect(useTuiStore.getState().messages[0]?.toolCalls).toHaveLength(1);
    expect(useTuiStore.getState().messages[0]?.toolCalls?.[0]?.name).toBe(
      "bash",
    );
  });

  test("updateToolCall patches the matching record", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: 1,
      streaming: true,
      toolCalls: [],
    });
    useTuiStore.getState().startToolCall({
      id: "tc-1",
      name: "bash",
      input: { command: "ls" },
      status: "running",
      startedAt: 1,
    });
    useTuiStore.getState().updateToolCall("tc-1", {
      status: "done",
      output: "files",
      finishedAt: 2,
    });
    const tc = useTuiStore.getState().messages[0]?.toolCalls?.[0];
    expect(tc?.status).toBe("done");
    expect(tc?.output).toBe("files");
    expect(tc?.finishedAt).toBe(2);
  });

  test("updateToolCall ignores unknown ids", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "assistant",
      content: "",
      timestamp: 1,
      streaming: true,
      toolCalls: [
        {
          id: "tc-1",
          name: "bash",
          input: {},
          status: "running",
          startedAt: 1,
        },
      ],
    });
    useTuiStore.getState().updateToolCall("ghost", { status: "done" });
    expect(useTuiStore.getState().messages[0]?.toolCalls?.[0]?.status).toBe(
      "running",
    );
  });
});

describe("setStreaming", () => {
  test("toggles isStreaming", () => {
    useTuiStore.getState().setStreaming(true, "m1");
    expect(useTuiStore.getState().isStreaming).toBe(true);
    expect(useTuiStore.getState().currentStreamingId).toBe("m1");
    useTuiStore.getState().setStreaming(false);
    expect(useTuiStore.getState().isStreaming).toBe(false);
    expect(useTuiStore.getState().currentStreamingId).toBeNull();
  });
});

describe("setPendingApproval", () => {
  test("sets and clears the approval request", () => {
    const req = {
      id: "approval-1",
      toolName: "bash",
      input: { command: "rm -rf /" },
      riskLevel: "high" as const,
    };
    useTuiStore.getState().setPendingApproval(req);
    expect(useTuiStore.getState().pendingApproval).toEqual(req);
    useTuiStore.getState().setPendingApproval(null);
    expect(useTuiStore.getState().pendingApproval).toBeNull();
  });
});

describe("input history navigation", () => {
  test("pushInputHistory stores entries and caps the list at 200", () => {
    for (let i = 0; i < 250; i++) {
      useTuiStore.getState().pushInputHistory(`entry-${String(i)}`);
    }
    expect(useTuiStore.getState().inputHistory).toHaveLength(200);
    expect(useTuiStore.getState().inputHistory[0]).toBe("entry-50");
    expect(useTuiStore.getState().inputHistory[199]).toBe("entry-249");
  });

  test("pushInputHistory resets the cursor", () => {
    useTuiStore.getState().pushInputHistory("first");
    useTuiStore.getState().pushInputHistory("second");
    expect(useTuiStore.getState().inputHistoryIndex).toBe(-1);
  });

  test("moveInputHistory walks back and forth", () => {
    useTuiStore.getState().pushInputHistory("a");
    useTuiStore.getState().pushInputHistory("b");
    expect(useTuiStore.getState().moveInputHistory(-1)).toBe("b");
    expect(useTuiStore.getState().moveInputHistory(-1)).toBe("a");
    expect(useTuiStore.getState().moveInputHistory(-1)).toBe("a"); // clamped
    expect(useTuiStore.getState().moveInputHistory(1)).toBe("b");
    expect(useTuiStore.getState().moveInputHistory(1)).toBe(""); // empty past the end
  });

  test("moveInputHistory returns null when history is empty", () => {
    expect(useTuiStore.getState().moveInputHistory(-1)).toBeNull();
  });

  test("resetInputHistoryIndex returns to -1", () => {
    useTuiStore.getState().pushInputHistory("a");
    useTuiStore.getState().moveInputHistory(-1);
    expect(useTuiStore.getState().inputHistoryIndex).toBeGreaterThanOrEqual(0);
    useTuiStore.getState().resetInputHistoryIndex();
    expect(useTuiStore.getState().inputHistoryIndex).toBe(-1);
  });
});

describe("clearMessages", () => {
  test("empties the messages array", () => {
    useTuiStore.getState().addMessage({
      id: "m1",
      role: "user",
      content: "hi",
      timestamp: 1,
    });
    useTuiStore.getState().clearMessages();
    expect(useTuiStore.getState().messages).toHaveLength(0);
  });
});

describe("selectIsBusy", () => {
  test("returns true while streaming", () => {
    useTuiStore.getState().setStreaming(true);
    expect(selectIsBusy(useTuiStore.getState())).toBe(true);
  });

  test("returns true while waiting for approval", () => {
    useTuiStore.getState().setPendingApproval({
      id: "a",
      toolName: "bash",
      input: {},
      riskLevel: "low",
    });
    expect(selectIsBusy(useTuiStore.getState())).toBe(true);
  });

  test("returns false in idle state", () => {
    useTuiStore.getState().setStreaming(false);
    useTuiStore.getState().setPendingApproval(null);
    expect(selectIsBusy(useTuiStore.getState())).toBe(false);
  });
});
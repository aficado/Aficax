// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\tests\slash.test.ts
// Tests for the slash-command dispatcher. The handler is pure: it
// receives a context and returns a structured SlashResult without
// touching the network or the filesystem. We assert on the HTTP call
// that the TUI would issue next.

import { describe, expect, test } from "bun:test";

import {
  createSlashHandler,
  detectTestCommand,
  SLASH_COMMANDS,
  type SlashContext,
} from "../src/slash/handler.js";

const baseCtx: SlashContext = {
  serverUrl: "http://127.0.0.1:7433",
  sessionId: "aficax-sess-test",
  workingDir: "/tmp/work",
};

const handler = createSlashHandler();

describe("SlashHandler.handle — local actions", () => {
  test("/clear returns a clear-screen local action", () => {
    const result = handler.handle("/clear", baseCtx);
    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.action.kind).toBe("clear-screen");
    }
  });

  test("/debug returns a toggle-debug local action", () => {
    const result = handler.handle("/debug", baseCtx);
    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.action.kind).toBe("toggle-debug");
    }
  });

  test("/exit returns an exit-confirm local action", () => {
    const result = handler.handle("/exit", baseCtx);
    expect(result.kind).toBe("local");
    if (result.kind === "local") {
      expect(result.action.kind).toBe("exit-confirm");
    }
  });
});

describe("SlashHandler.handle — http actions", () => {
  test("/new POSTs a new session", () => {
    const result = handler.handle("/new", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.method).toBe("POST");
      expect(result.call.path).toBe("/sessions");
      expect(result.call.body).toEqual({
        workingDir: "/tmp/work",
        model: "claude-sonnet-4-6",
        provider: "anthropic",
      });
    }
  });

  test("/model PATCHes the active session", () => {
    const result = handler.handle("/model gpt-4o", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.method).toBe("PATCH");
      expect(result.call.path).toBe(`/sessions/${baseCtx.sessionId}`);
      expect(result.call.body).toEqual({ model: "gpt-4o" });
    }
  });

  test("/provider PATCHes the active session", () => {
    const result = handler.handle("/provider openai", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.body).toEqual({ provider: "openai" });
    }
  });

  test("/mode PATCHes the active session", () => {
    const result = handler.handle("/mode plan", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.body).toEqual({ mode: "plan" });
    }
  });

  test("/status GETs the active session", () => {
    const result = handler.handle("/status", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.method).toBe("GET");
      expect(result.call.path).toBe(`/sessions/${baseCtx.sessionId}`);
      expect(result.call.printResponse).toBe(true);
    }
  });

  test("/compact POSTs /compact on the active session", () => {
    const result = handler.handle("/compact", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.method).toBe("POST");
      expect(result.call.path).toBe(`/sessions/${baseCtx.sessionId}/compact`);
    }
  });

  test("/resume needs a session id", () => {
    const result = handler.handle("/resume", baseCtx);
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.text).toContain("Usage");
    }
  });

  test("/resume with id POSTs /sessions/:id/resume", () => {
    const result = handler.handle("/resume abc-123", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toBe("/sessions/abc-123/resume");
    }
  });

  test("/tools GETs /tools", () => {
    const result = handler.handle("/tools", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toBe("/tools");
    }
  });

  test("/mcp GETs /mcp/servers", () => {
    const result = handler.handle("/mcp", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toBe("/mcp/servers");
    }
  });

  test("/skills GETs /skills", () => {
    const result = handler.handle("/skills", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toBe("/skills");
    }
  });

  test("/history GETs /sessions", () => {
    const result = handler.handle("/history", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toBe("/sessions");
    }
  });

  test("/memory GETs /memory with the working dir", () => {
    const result = handler.handle("/memory", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.path).toContain("/memory");
      expect(result.call.path).toContain("cwd=");
    }
  });

  test("/allow POSTs to /allowlist with the pattern", () => {
    const result = handler.handle("/allow npm test", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.body).toEqual({ pattern: "npm test" });
    }
  });

  test("/deny POSTs to /denylist with the pattern", () => {
    const result = handler.handle("/deny rm -rf", baseCtx);
    expect(result.kind).toBe("http");
    if (result.kind === "http") {
      expect(result.call.body).toEqual({ pattern: "rm -rf" });
    }
  });
});

describe("SlashHandler.handle — input validation", () => {
  test("/model without a value emits a usage message", () => {
    const result = handler.handle("/model", baseCtx);
    expect(result.kind).toBe("message");
    if (result.kind === "message") {
      expect(result.text).toContain("Usage");
    }
  });

  test("/provider without a value emits a usage message", () => {
    const result = handler.handle("/provider", baseCtx);
    expect(result.kind).toBe("message");
  });

  test("/mode without a value emits a usage message", () => {
    const result = handler.handle("/mode", baseCtx);
    expect(result.kind).toBe("message");
  });

  test("unknown commands return kind=unknown", () => {
    const result = handler.handle("/totally-unknown", baseCtx);
    expect(result.kind).toBe("unknown");
  });

  test("non-slash input returns kind=unknown", () => {
    const result = handler.handle("hello world", baseCtx);
    expect(result.kind).toBe("unknown");
  });
});

describe("SlashHandler.handle — session-less context", () => {
  const ctxNoSession: SlashContext = { serverUrl: baseCtx.serverUrl };

  test("/compact requires a session", () => {
    expect(() => handler.handle("/compact", ctxNoSession)).toThrow();
  });

  test("/status requires a session", () => {
    expect(() => handler.handle("/status", ctxNoSession)).toThrow();
  });

  test("/model requires a session", () => {
    expect(() => handler.handle("/model gpt-4o", ctxNoSession)).toThrow();
  });
});

describe("SlashHandler.suggest", () => {
  test("empty prefix returns every command", () => {
    expect(handler.suggest("").length).toBe(SLASH_COMMANDS.length);
  });

  test("matching prefix narrows the list", () => {
    const out = handler.suggest("/mo");
    expect(out.map((c) => c.command)).toContain("model");
    expect(out.map((c) => c.command)).toContain("mode");
    expect(out.map((c) => c.command)).not.toContain("clear");
  });

  test("strips a leading slash", () => {
    expect(handler.suggest("/help").map((c) => c.command)).toEqual(["help"]);
  });

  test("non-matching prefix returns empty", () => {
    expect(handler.suggest("/zzzzz")).toEqual([]);
  });
});

describe("detectTestCommand", () => {
  test("returns bun test for node/typescript projects", () => {
    expect(detectTestCommand("/tmp/with-bun-and-node_modules")).toBe(
      "bun test",
    );
  });

  test("returns pytest for python projects", () => {
    expect(detectTestCommand("/tmp/with-pyproject.toml")).toBe("pytest");
  });

  test("returns cargo test for rust projects", () => {
    expect(detectTestCommand("/tmp/with-Cargo.toml")).toBe("cargo test");
  });

  test("returns go test for go projects", () => {
    expect(detectTestCommand("/tmp/with-go.mod")).toBe("go test ./...");
  });

  test("returns a hint for unknown project types", () => {
    const out = detectTestCommand("/tmp/empty");
    expect(out).toContain("no test command detected");
  });

  test("falls back to process.cwd() when undefined", () => {
    const out = detectTestCommand(undefined);
    expect(typeof out).toBe("string");
  });
});

describe("SLASH_COMMANDS catalogue", () => {
  test("every entry has a non-empty description", () => {
    for (const c of SLASH_COMMANDS) {
      expect(c.command.length).toBeGreaterThan(0);
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  test("command names are unique", () => {
    const names = SLASH_COMMANDS.map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  test("includes the essentials (model, mode, clear, exit)", () => {
    const names = SLASH_COMMANDS.map((c) => c.command);
    expect(names).toContain("model");
    expect(names).toContain("mode");
    expect(names).toContain("clear");
    expect(names).toContain("exit");
  });
});
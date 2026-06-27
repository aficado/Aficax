// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\tests\storage.test.ts
// Tests for the storage stack: sessions, messages, transcripts and
// checkpoints. Uses an in-memory SQLite database to keep the suite
// hermetic.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Message, ToolCall } from "@aficax/core";

import { createSessionManager } from "../src/session/manager.js";
import { openInMemoryDatabase } from "../src/storage/db.js";
import { createMessageStorage } from "../src/storage/messages.js";
import { createSessionStorage } from "../src/storage/sessions.js";
import {
  appendTranscriptEvent,
  readAllTranscript,
  readRawTranscript,
  transcriptPath,
} from "../src/storage/transcripts.js";

type DbHandle = ReturnType<typeof openInMemoryDatabase>;

let handle: DbHandle;

beforeEach(() => {
  handle = openInMemoryDatabase();
});

afterEach(() => {
  handle.close();
});

describe("sessions", () => {
  test("create + cache hit + list round trip", () => {
    const sessions = createSessionStorage(handle.db);
    const messages = createMessageStorage(handle.db);
    const manager = createSessionManager({ sessions, messages });

    const session = manager.create("/tmp", "claude-sonnet-4-6", "anthropic");
    expect(session.id.length).toBeGreaterThan(0);

    const got = manager.get(session.id);
    expect(got?.id).toBe(session.id);

    const summaries = manager.list();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe(session.id);
  });

  test("setStatus and resume cycle", () => {
    const sessions = createSessionStorage(handle.db);
    const messages = createMessageStorage(handle.db);
    const manager = createSessionManager({ sessions, messages });

    const session = manager.create("/tmp", "claude-sonnet-4-6", "anthropic");
    manager.setStatus(session.id, "paused");
    expect(manager.get(session.id)?.status).toBe("paused");
    manager.resume(session.id);
    expect(manager.get(session.id)?.status).toBe("active");
  });

  test("delete removes the session from the cache and the index", () => {
    const sessions = createSessionStorage(handle.db);
    const messages = createMessageStorage(handle.db);
    const manager = createSessionManager({ sessions, messages });

    const session = manager.create("/tmp", "claude-sonnet-4-6", "anthropic");
    manager.delete(session.id);
    expect(manager.get(session.id)).toBeUndefined();
    expect(manager.list()).toHaveLength(0);
  });

  test("addMessage hydrates the session back from SQLite", async () => {
    const sessions = createSessionStorage(handle.db);
    const messages = createMessageStorage(handle.db);
    const manager = createSessionManager({ sessions, messages });

    const session = manager.create("/tmp", "claude-sonnet-4-6", "anthropic");
    const msg: Message = {
      id: "m1",
      role: "user",
      content: { kind: "text", text: "hello" },
      timestamp: Date.now(),
    };
    await manager.addMessage(session.id, msg);
    expect(manager.get(session.id)?.messages).toHaveLength(1);

    // Force a cache miss and re-hydrate.
    manager.invalidate(session.id);
    const fresh = manager.get(session.id);
    expect(fresh?.messages).toHaveLength(1);
    expect(fresh?.messages[0]?.id).toBe("m1");
  });

  test("addToolCall appends and counts", () => {
    const sessions = createSessionStorage(handle.db);
    const messages = createMessageStorage(handle.db);
    const manager = createSessionManager({ sessions, messages });

    const session = manager.create("/tmp", "claude-sonnet-4-6", "anthropic");
    const tc: ToolCall = {
      id: "tc-1",
      toolName: "read_file",
      input: { path: "/tmp/x" },
      status: "done",
    };
    manager.addToolCall(session.id, tc, "msg-1");
    expect(manager.get(session.id)?.toolCalls).toHaveLength(1);
  });
});

describe("transcripts", () => {
  test("appendTranscriptEvent + readAllTranscript round trip", async () => {
    const sessionId = "test-session-transcript";
    await appendTranscriptEvent(sessionId, {
      type: "session_start",
      sessionId,
      timestamp: 1,
      model: "x",
      provider: "y",
      workingDir: "/tmp",
    });
    await appendTranscriptEvent(sessionId, {
      type: "status",
      sessionId,
      timestamp: 2,
      status: "thinking",
      detail: "Turn 1",
    });

    const events = await readAllTranscript(sessionId);
    // We get at least the two events we appended; the message_start
    // helper may also append a generated message event.
    expect(events.length).toBeGreaterThanOrEqual(2);
    const types = events.map((e) => e.type);
    expect(types).toContain("session_start");
    expect(types).toContain("status");
  });

  test("readRawTranscript returns the JSONL string", async () => {
    const sessionId = "test-session-raw";
    await appendTranscriptEvent(sessionId, {
      type: "session_start",
      sessionId,
      timestamp: 1,
      model: "x",
      provider: "y",
      workingDir: "/tmp",
    });
    const raw = await readRawTranscript(sessionId);
    expect(raw).not.toBeNull();
    expect(raw).toContain("session_start");
    expect(raw!.split("\n").length).toBeGreaterThan(0);
  });

  test("readRawTranscript returns null for unknown sessions", async () => {
    const raw = await readRawTranscript("does-not-exist");
    expect(raw).toBeNull();
  });

  test("transcriptPath lives under the session dir", () => {
    const path = transcriptPath("abc");
    expect(path).toContain("abc");
    expect(path).toMatch(/transcript\.jsonl$/);
  });
});
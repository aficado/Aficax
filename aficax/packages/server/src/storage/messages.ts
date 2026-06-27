// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\messages.ts
// Low-level CRUD for the `messages` and `tool_calls` tables.

import type {
  Message,
  MessageContent,
  SessionId,
  ToolCall,
  ToolCallStatus,
} from '@aficax/core';
import { and, asc, eq, inArray } from 'drizzle-orm';

import type { AficaxDatabase } from './db.js';
import {
  type MessageRow,
  type NewMessageRow,
  type NewToolCallRow,
  type ToolCallRow,
  messages as messagesTable,
  toolCalls as toolCallsTable,
} from './schema.js';

/** Storage operations for the messages and tool_calls tables. */
export class MessageStorage {
  constructor(private readonly db: AficaxDatabase) {}

  /** Insert a single message. */
  insert(message: Message, sessionId: SessionId): void {
    const row: NewMessageRow = {
      id: message.id,
      sessionId,
      role: message.role,
      content: JSON.stringify(message.content),
      timestamp: message.timestamp,
    };
    if (message.tokenCount !== undefined) {
      row.tokenCount = message.tokenCount;
    }
    if (extractToolCallId(message.content) !== undefined) {
      row.toolCallId = extractToolCallId(message.content);
    }
    this.db.insert(messagesTable).values(row).run();
  }

  /** Update the token count of a message. */
  setTokenCount(messageId: string, tokens: number): void {
    this.db
      .update(messagesTable)
      .set({ tokenCount: tokens })
      .where(eq(messagesTable.id, messageId))
      .run();
  }

  /** List message ids belonging to a session. */
  listIdsForSession(sessionId: SessionId): string[] {
    const rows = this.db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .all();
    return rows.map((r) => r.id);
  }

  /** List all messages of a session in chronological order. */
  listForSession(sessionId: SessionId): Message[] {
    const rows = this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .orderBy(asc(messagesTable.timestamp))
      .all();
    return rows.map(rowToMessage);
  }

  /** Count of messages for a session. */
  countForSession(sessionId: SessionId): number {
    const rows = this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .all();
    return rows.length;
  }

  /** Delete every message of a session. */
  deleteForSession(sessionId: SessionId): void {
    this.db.delete(messagesTable).where(eq(messagesTable.sessionId, sessionId)).run();
  }

  /** Insert a single tool-call row. */
  insertToolCall(toolCall: ToolCall, sessionId: SessionId, messageId: string): void {
    const row: NewToolCallRow = {
      id: toolCall.id,
      sessionId,
      messageId,
      toolName: toolCall.toolName,
      input: JSON.stringify(toolCall.input ?? {}),
      status: toolCall.status,
      timestamp: Date.now(),
    };
    if (toolCall.output !== undefined) {
      row.output = JSON.stringify(toolCall.output);
    }
    if (toolCall.duration !== undefined) {
      row.durationMs = toolCall.duration;
    }
    this.db.insert(toolCallsTable).values(row).run();
  }

  /** Update an existing tool call. */
  updateToolCall(
    id: string,
    partial: { status?: ToolCallStatus; output?: string; durationMs?: number },
  ): void {
    const updates: { status?: string; output?: string; durationMs?: number } = {};
    if (partial.status !== undefined) {
      updates.status = partial.status;
    }
    if (partial.output !== undefined) {
      updates.output = JSON.stringify(partial.output);
    }
    if (partial.durationMs !== undefined) {
      updates.durationMs = partial.durationMs;
    }
    this.db
      .update(toolCallsTable)
      .set(updates)
      .where(eq(toolCallsTable.id, id))
      .run();
  }

  /** List tool calls for a session. */
  listToolCallsForSession(sessionId: SessionId): ToolCall[] {
    const rows = this.db
      .select()
      .from(toolCallsTable)
      .where(eq(toolCallsTable.sessionId, sessionId))
      .orderBy(asc(toolCallsTable.timestamp))
      .all();
    return rows.map(rowToToolCall);
  }

  /** Find a tool call by id. */
  findToolCall(id: string): ToolCall | undefined {
    const row = this.db
      .select()
      .from(toolCallsTable)
      .where(eq(toolCallsTable.id, id))
      .get();
    return row ? rowToToolCall(row) : undefined;
  }
}

/** Extract the tool-call id from a MessageContent, when present. */
function extractToolCallId(content: MessageContent): string | undefined {
  if (content.kind === 'tool_use' || content.kind === 'tool_result') {
    return content.toolCallId;
  }
  return undefined;
}

/** Convert a raw messages row into the core's `Message`. */
function rowToMessage(row: MessageRow): Message {
  const base: {
    id: string;
    role: Message['role'];
    content: MessageContent;
    timestamp: number;
    tokenCount?: number;
    toolCallId?: string;
  } = {
    id: row.id,
    role: row.role as Message['role'],
    content: safeParseJsonAsContent(row.content),
    timestamp: row.timestamp,
  };
  if (row.tokenCount !== null) {
    base.tokenCount = row.tokenCount;
  }
  if (row.toolCallId !== null) {
    base.toolCallId = row.toolCallId;
  }
  return base;
}

/** Convert a raw tool_calls row into the core's `ToolCall`. */
function rowToToolCall(row: ToolCallRow): ToolCall {
  const base: ToolCall = {
    id: row.id,
    toolName: row.toolName,
    input: safeParseJson<Record<string, unknown>>(row.input, {}),
    status: row.status as ToolCallStatus,
  };
  if (row.output !== null) {
    const parsed = safeParseJson<unknown>(row.output, null);
    if (typeof parsed === 'string') {
      (base as { output?: string }).output = parsed;
    }
  }
  if (row.durationMs !== null) {
    (base as { duration?: number }).duration = row.durationMs;
  }
  return base;
}

/** Safely parse a JSON string with a fallback value. */
function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Safely parse a JSON string, defaulting to a text content on failure. */
function safeParseJsonAsContent(raw: string): MessageContent {
  try {
    return JSON.parse(raw) as MessageContent;
  } catch {
    return { kind: 'text', text: raw };
  }
}

/** Build a {@link MessageStorage} bound to a database. */
export function createMessageStorage(db: AficaxDatabase): MessageStorage {
  return new MessageStorage(db);
}

// Keep `and` and `inArray` in scope for future composite filters.
void and;
void inArray;

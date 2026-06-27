// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\schema.ts
// Drizzle schema for the Aficax SQLite database. Three tables: sessions,
// messages, tool_calls. JSON payloads (content, input, output) are stored as
// TEXT and serialised by the storage layer.

import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Top-level session record. One row per conversation. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  workingDir: text('working_dir').notNull(),
  model: text('model').notNull(),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  totalInputTokens: integer('total_input_tokens').notNull().default(0),
  totalOutputTokens: integer('total_output_tokens').notNull().default(0),
  estimatedCostUsd: real('estimated_cost_usd'),
  /** Auto-generated from the first user message (truncated to 50 chars). */
  title: text('title'),
});

/** A single message in a session. `content` is a JSON-serialised MessageContent. */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull().references(() => sessions.id),
  role: text('role').notNull(),
  /** JSON-encoded {@link MessageContent}. */
  content: text('content').notNull(),
  timestamp: integer('timestamp').notNull(),
  tokenCount: integer('token_count'),
  /** Set when role is 'tool_use' or 'tool_result'. */
  toolCallId: text('tool_call_id'),
});

/** A single tool invocation recorded for a session. */
export const toolCalls = sqliteTable('tool_calls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  messageId: text('message_id').notNull(),
  toolName: text('tool_name').notNull(),
  /** JSON-encoded input. */
  input: text('input').notNull(),
  /** JSON-encoded output (may be null while still running). */
  output: text('output'),
  status: text('status').notNull(),
  durationMs: integer('duration_ms'),
  timestamp: integer('timestamp').notNull(),
});

/** Convenience type aliases inferred from the schema. */
export type SessionRow = typeof sessions.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ToolCallRow = typeof toolCalls.$inferSelect;

export type NewSessionRow = typeof sessions.$inferInsert;
export type NewMessageRow = typeof messages.$inferInsert;
export type NewToolCallRow = typeof toolCalls.$inferInsert;

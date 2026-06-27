// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\sessions.ts
// Low-level CRUD for the `sessions` table. The SessionManager (in
// session/manager.ts) wraps this and adds an in-memory cache.

import {
  createSessionId,
  type Session,
  type SessionId,
  type SessionStatus,
  type SessionSummary,
  type ToolCall,
} from '@aficax/core';
import { count, desc, eq } from 'drizzle-orm';

import type { AficaxDatabase } from './db.js';
import {
  type NewSessionRow,
  type SessionRow,
  messages as messagesTable,
  sessions as sessionsTable,
  toolCalls as toolCallsTable,
} from './schema.js';

/** Convert a raw DB row into the core's `Session` shape. */
function rowToSession(row: SessionRow): Session {
  const base: Session = {
    id: createSessionId(row.id),
    workingDir: row.workingDir,
    model: row.model,
    provider: row.provider,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: row.status as SessionStatus,
    messages: [],
    toolCalls: [],
    totalTokens: row.totalInputTokens + row.totalOutputTokens,
  };
  let result: Session = base;
  if (row.estimatedCostUsd !== null) {
    result = { ...result, estimatedCost: row.estimatedCostUsd };
  }
  if (row.title !== null) {
    result = { ...result, title: row.title };
  }
  return result;
}

/** Convert a `Session` to a row ready for insertion. */
function sessionToRow(session: Session): NewSessionRow {
  const base: NewSessionRow = {
    id: session.id,
    workingDir: session.workingDir,
    model: session.model,
    provider: session.provider,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    totalInputTokens: Math.max(0, session.totalTokens),
    totalOutputTokens: 0,
    title: null,
  };
  if (session.estimatedCost !== undefined) {
    return { ...base, estimatedCostUsd: session.estimatedCost };
  }
  return base;
}

/** Filter accepted when listing sessions. */
export interface SessionListFilter {
  readonly status?: SessionStatus;
  readonly limit?: number;
}

/** Raw session storage operations. SQLite is the source of truth. */
export class SessionStorage {
  constructor(private readonly db: AficaxDatabase) {}

  /** Insert a brand-new session. Throws if `session.id` already exists. */
  insert(session: Session): void {
    this.db.insert(sessionsTable).values(sessionToRow(session)).run();
  }

  /** Look up a session by id, or return `undefined`. */
  findById(id: SessionId): Session | undefined {
    const row = this.db
      .select()
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id))
      .get();
    return row ? rowToSession(row) : undefined;
  }

  /** Update mutable fields. The id and createdAt are preserved. */
  update(id: SessionId, partial: Partial<Omit<Session, 'id' | 'createdAt'>>): Session | undefined {
    const current = this.findById(id);
    if (!current) {
      return undefined;
    }
    const merged: Session = {
      ...current,
      ...partial,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
    };
    this.db
      .update(sessionsTable)
      .set({
        workingDir: merged.workingDir,
        model: merged.model,
        provider: merged.provider,
        status: merged.status,
        updatedAt: merged.updatedAt,
        totalInputTokens: Math.max(0, merged.totalTokens),
        estimatedCostUsd: merged.estimatedCost ?? null,
        title: merged.title ?? null,
      })
      .where(eq(sessionsTable.id, id))
      .run();
    return merged;
  }

  /** Set the lifecycle status of a session. */
  setStatus(id: SessionId, status: SessionStatus): Session | undefined {
    return this.update(id, { status });
  }

  /** Mark a session active and refresh `updatedAt`. */
  resume(id: SessionId): Session | undefined {
    return this.update(id, { status: 'active' });
  }

  /** Permanently delete a session row and all dependent data. */
  delete(id: SessionId): boolean {
    this.db.delete(messagesTable).where(eq(messagesTable.sessionId, id)).run();
    this.db.delete(toolCallsTable).where(eq(toolCallsTable.sessionId, id)).run();
    const before = this.findById(id);
    this.db.delete(sessionsTable).where(eq(sessionsTable.id, id)).run();
    return before !== undefined;
  }

  /** List sessions (most-recent first) as {@link SessionSummary} objects. */
  list(filter: SessionListFilter = {}): SessionSummary[] {
    const baseQuery = this.db
      .select()
      .from(sessionsTable)
      .orderBy(desc(sessionsTable.updatedAt));

    const rows =
      filter.status !== undefined
        ? baseQuery.where(eq(sessionsTable.status, filter.status)).all()
        : baseQuery.all();

    const limit = filter.limit ?? rows.length;
    return rows.slice(0, limit).map((row) => this.rowToSummary(row));
  }

  /** Hydrate a session with its full message and tool-call history. */
  hydrate(id: SessionId): Session | undefined {
    const session = this.findById(id);
    if (!session) {
      return undefined;
    }
    const msgRows = this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, id))
      .orderBy(messagesTable.timestamp)
      .all();
    const tcRows = this.db
      .select()
      .from(toolCallsTable)
      .where(eq(toolCallsTable.sessionId, id))
      .orderBy(toolCallsTable.timestamp)
      .all();

    const toolCalls: ToolCall[] = tcRows.map((row) => {
      const base: ToolCall = {
        id: row.id,
        toolName: row.toolName,
        input: safeParseJson(row.input, {}),
        status: row.status as ToolCall['status'],
      };
      if (row.output !== null) {
        const parsed = safeParseJson(row.output, null);
        if (typeof parsed === 'string') {
          (base as { output?: string }).output = parsed;
        }
      }
      if (row.durationMs !== null) {
        (base as { duration?: number }).duration = row.durationMs;
      }
      return base;
    });

    return {
      ...session,
      messages: msgRows.map((row) => {
        const base: {
          id: string;
          role: Session['messages'][number]['role'];
          content: Session['messages'][number]['content'];
          timestamp: number;
          tokenCount?: number;
          toolCallId?: string;
        } = {
          id: row.id,
          role: row.role as Session['messages'][number]['role'],
          content: safeParseJson(row.content, { kind: 'text', text: '' }),
          timestamp: row.timestamp,
        };
        if (row.tokenCount !== null) {
          base.tokenCount = row.tokenCount;
        }
        if (row.toolCallId !== null) {
          base.toolCallId = row.toolCallId;
        }
        return base;
      }),
      toolCalls,
    };
  }

  /** Count of session rows. */
  count(): number {
    const result = this.db.select({ value: count() }).from(sessionsTable).get();
    return result?.value ?? 0;
  }

  /** True if a row with this id exists. */
  exists(id: SessionId): boolean {
    const row = this.db
      .select({ id: sessionsTable.id })
      .from(sessionsTable)
      .where(eq(sessionsTable.id, id))
      .get();
    return row !== null && row !== undefined;
  }

  /** Build a summary from a raw row, computing counts inline. */
  private rowToSummary(row: SessionRow): SessionSummary {
    const msgCount =
      this.db
        .select({ value: count() })
        .from(messagesTable)
        .where(eq(messagesTable.sessionId, row.id))
        .get()?.value ?? 0;
    const tcCount =
      this.db
        .select({ value: count() })
        .from(toolCallsTable)
        .where(eq(toolCallsTable.sessionId, row.id))
        .get()?.value ?? 0;
    const totalTokens = row.totalInputTokens + row.totalOutputTokens;
    const base: SessionSummary = {
      id: createSessionId(row.id),
      workingDir: row.workingDir,
      model: row.model,
      provider: row.provider,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      status: row.status as SessionStatus,
      messageCount: msgCount,
      toolCallCount: tcCount,
      totalTokens,
    };
    let result: SessionSummary = base;
    if (row.estimatedCostUsd !== null) {
      result = { ...result, estimatedCost: row.estimatedCostUsd };
    }
    if (row.title !== null) {
      result = { ...result, title: row.title };
    }
    return result;
  }
}

/** Safely parse a JSON string, falling back to `fallback` on failure. */
function safeParseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Build a {@link SessionStorage} bound to a database. */
export function createSessionStorage(db: AficaxDatabase): SessionStorage {
  return new SessionStorage(db);
}

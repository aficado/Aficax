// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\session\manager.ts
// SessionManager: front-end for the rest of the server. Wraps the SQLite
// storage layer with an in-memory cache (source of truth = SQLite).

import {
  createSessionId,
  getLogger,
  SESSION_ID_PREFIX,
  toSessionSummary,
  type Message,
  type Session,
  type SessionId,
  type SessionStatus,
  type SessionSummary,
  type ToolCall,
  type ToolCallStatus,
} from '@aficax/core';

import type { SessionStorage } from '../storage/sessions.js';
import type { MessageStorage } from '../storage/messages.js';
import { appendTranscriptEvent } from '../storage/transcripts.js';

const logger = getLogger();

/** Maximum length of an auto-generated session title. */
const TITLE_MAX_LENGTH = 50;

/** Generate a new session id with the configured prefix. */
function generateSessionId(): SessionId {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return createSessionId(`${SESSION_ID_PREFIX}${ts}-${rand}`);
}

/** Build a short title from the first user message. */
export function generateSessionTitle(firstMessage: string): string {
  const collapsed = firstMessage.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return 'New session';
  }
  if (collapsed.length <= TITLE_MAX_LENGTH) {
    return collapsed;
  }
  return collapsed.slice(0, TITLE_MAX_LENGTH - 1) + '…';
}

/** Dependencies of the SessionManager. */
export interface SessionManagerDeps {
  readonly sessions: SessionStorage;
  readonly messages: MessageStorage;
}

/** SessionManager: in-memory cache backed by SQLite. */
export class SessionManager {
  private readonly cache: Map<SessionId, Session> = new Map();
  private readonly deps: SessionManagerDeps;

  constructor(deps: SessionManagerDeps) {
    this.deps = deps;
  }

  /** Create a new session. Persists to SQLite and warms the cache. */
  create(workingDir: string, model: string, provider: string): Session {
    const now = Date.now();
    const session: Session = {
      id: generateSessionId(),
      workingDir,
      model,
      provider,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      messages: [],
      toolCalls: [],
      totalTokens: 0,
    };
    this.deps.sessions.insert(session);
    this.cache.set(session.id, session);
    logger.debug('Session created', { id: session.id, workingDir });
    return session;
  }

  /** Fetch a session by id. Hydrated from SQLite on cache miss. */
  get(id: SessionId): Session | undefined {
    const cached = this.cache.get(id);
    if (cached) {
      return cached;
    }
    const loaded = this.deps.sessions.hydrate(id);
    if (loaded) {
      this.cache.set(id, loaded);
    }
    return loaded;
  }

  /** Return a lightweight projection (no message bodies). */
  getSummary(id: SessionId): SessionSummary | undefined {
    const session = this.get(id);
    if (!session) {
      return undefined;
    }
    return toSessionSummary(session);
  }

  /** Check existence of a session (in cache or DB). */
  has(id: SessionId): boolean {
    if (this.cache.has(id)) {
      return true;
    }
    return this.deps.sessions.exists(id);
  }

  /**
   * Apply a partial update. Persists to SQLite, refreshes the cache, and
   * returns the new value. Throws if the session does not exist.
   */
  update(id: SessionId, partial: Partial<Omit<Session, 'id' | 'createdAt'>>): Session {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Session ${id} not found`);
    }
    const updated = this.deps.sessions.update(id, partial);
    if (!updated) {
      throw new Error(`Session ${id} not found in storage`);
    }
    const merged: Session = {
      ...updated,
      messages: current.messages,
      toolCalls: current.toolCalls,
    };
    this.cache.set(id, merged);
    return merged;
  }

  /** Append a message. Persists to SQLite and to the JSONL transcript. */
  async addMessage(id: SessionId, message: Message): Promise<Session> {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Session ${id} not found`);
    }
    this.deps.messages.insert(message, id);
    await appendTranscriptEvent(id, makeMessageEvent(id, message));

    // Auto-derive a title from the first user message, when not set yet.
    let withTitle = current;
    if (current.title === undefined && message.role === 'user' && message.content.kind === 'text') {
      const generated = generateSessionTitle(message.content.text);
      withTitle = { ...current, title: generated };
      this.deps.sessions.update(id, { title: generated });
    }

    const merged: Session = {
      ...withTitle,
      messages: [...withTitle.messages, message],
      updatedAt: Date.now(),
    };
    this.cache.set(id, merged);
    return merged;
  }

  /** Append a tool-call record. */
  addToolCall(id: SessionId, toolCall: ToolCall, messageId: string): Session {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Session ${id} not found`);
    }
    this.deps.messages.insertToolCall(toolCall, id, messageId);
    const merged: Session = {
      ...current,
      toolCalls: [...current.toolCalls, toolCall],
      updatedAt: Date.now(),
    };
    this.cache.set(id, merged);
    return merged;
  }

  /** Update the status of a session. */
  setStatus(id: SessionId, status: SessionStatus): Session {
    return this.update(id, { status });
  }

  /** Mark a session as active and refresh `updatedAt`. */
  resume(id: SessionId): Session {
    return this.update(id, { status: 'active' });
  }

  /** Increment the total token counter by `delta`. */
  addTokens(id: SessionId, delta: number): Session {
    const current = this.get(id);
    if (!current) {
      throw new Error(`Session ${id} not found`);
    }
    return this.update(id, { totalTokens: current.totalTokens + delta });
  }

  /** Return lightweight summaries for every persisted session. */
  list(): SessionSummary[] {
    return this.deps.sessions.list();
  }

  /** Forget a session. Removes it from cache and deletes the DB row + transcript. */
  async delete(id: SessionId): Promise<boolean> {
    this.deps.sessions.delete(id);
    this.cache.delete(id);
    return true;
  }

  /** Invalidate a single cache entry without touching storage. */
  invalidate(id: SessionId): void {
    this.cache.delete(id);
  }

  /** Number of cached sessions (NOT the same as the count in storage). */
  cacheSize(): number {
    return this.cache.size;
  }

  /** Number of persisted sessions. */
  size(): number {
    return this.deps.sessions.count();
  }

  /** Set the auto-generated title of a session (called on first user message). */
  setTitle(id: SessionId, title: string): Session {
    return this.update(id, { title });
  }
}

/** Build a transcript-friendly event for a stored message. */
function makeMessageEvent(sessionId: SessionId, message: Message): import('@aficax/core').AnyAgentEvent {
  return {
    type: 'token',
    sessionId,
    timestamp: message.timestamp,
    text: `[${message.role}] ${messageIdToText(message)}`,
  };
}

function messageIdToText(message: Message): string {
  switch (message.content.kind) {
    case 'text':
      return message.content.text;
    case 'tool_use':
      return JSON.stringify(message.content.input);
    case 'tool_result':
      return message.content.content;
  }
}

/** Re-export for convenience. */
export type { ToolCallStatus };

/** Factory that creates a {@link SessionManager} bound to a storage pair. */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  return new SessionManager(deps);
}

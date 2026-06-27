// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\session.ts
// Session and message types shared by the server, the TUI, and the persistence layer.

/**
 * Branded identifier for a session. The brand prevents accidental mixing with
 * other string-typed identifiers (e.g. message ids, tool call ids).
 */
export type SessionId = string & { readonly __brand: 'SessionId' };

/** Prefix used when generating new session identifiers. */
export const SESSION_ID_PREFIX = 'aficax-sess-';

/** Wrap a raw string as a SessionId. Use only at trust boundaries (I/O). */
export function createSessionId(value: string): SessionId {
  return value as SessionId;
}

/** Roles a message can take in the conversation log. */
export type MessageRole = 'user' | 'assistant' | 'tool_result' | 'tool_use' | 'system';

/**
 * Discriminated union describing the payload of a {@link Message}. The `kind`
 * field is the discriminator.
 */
export type MessageContent =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'tool_use';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: Record<string, unknown>;
    }
  | {
      readonly kind: 'tool_result';
      readonly toolCallId: string;
      readonly toolName: string;
      readonly content: string;
      readonly isError: boolean;
    };

/** A single message exchanged with the model or produced by the loop. */
export interface Message {
  readonly id: string;
  readonly role: MessageRole;
  readonly content: MessageContent;
  readonly timestamp: number;
  /** Optional pre-computed token count, populated by the provider adapter. */
  readonly tokenCount?: number;
}

/** Lifecycle status of a single tool invocation. */
export type ToolCallStatus = 'pending' | 'running' | 'done' | 'error' | 'denied';

/** A single tool invocation as observed by the loop. */
export interface ToolCall {
  readonly id: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly output?: string;
  readonly status: ToolCallStatus;
  readonly duration?: number;
  readonly errorMessage?: string;
}

/** Top-level status of a session. */
export type SessionStatus = 'active' | 'paused' | 'completed' | 'error';

/** A full session including all messages and tool calls. */
export interface Session {
  readonly id: SessionId;
  readonly workingDir: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: SessionStatus;
  readonly messages: readonly Message[];
  readonly toolCalls: readonly ToolCall[];
  readonly totalTokens: number;
  readonly estimatedCost?: number;
  /** Optional human-readable title, derived from the first user message. */
  readonly title?: string;
}

/**
 * Lightweight projection of a session, suitable for listings and resume pickers.
 * It contains no message bodies.
 */
export interface SessionSummary {
  readonly id: SessionId;
  readonly workingDir: string;
  readonly model: string;
  readonly provider: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly status: SessionStatus;
  readonly messageCount: number;
  readonly toolCallCount: number;
  readonly totalTokens: number;
  readonly estimatedCost?: number;
  readonly title?: string;
}

/** Project a full {@link Session} down to a {@link SessionSummary}. */
export function toSessionSummary(session: Session): SessionSummary {
  const base: SessionSummary = {
    id: session.id,
    workingDir: session.workingDir,
    model: session.model,
    provider: session.provider,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    messageCount: session.messages.length,
    toolCallCount: session.toolCalls.length,
    totalTokens: session.totalTokens,
  };
  let withOptional: SessionSummary = base;
  if (session.estimatedCost !== undefined) {
    withOptional = { ...withOptional, estimatedCost: session.estimatedCost };
  }
  if (session.title !== undefined) {
    withOptional = { ...withOptional, title: session.title };
  }
  return withOptional;
}

/** Extract the textual portion of a message for token estimation. */
export function messageToText(message: Message): string {
  switch (message.content.kind) {
    case 'text':
      return message.content.text;
    case 'tool_use':
      return JSON.stringify(message.content.input);
    case 'tool_result':
      return message.content.content;
  }
}

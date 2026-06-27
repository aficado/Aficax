// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\event.ts
// Server-Sent Event payloads pushed from the Aficax server to the TUI client.

import type { SessionId, ToolCall } from './session.js';
import type { ToolResult } from './tool.js';
import type { PermissionDecision, PermissionRequest } from './permission.js';

/** All event kinds the server can emit. */
export type EventType =
  | 'token'
  | 'message_start'
  | 'message_end'
  | 'tool_start'
  | 'tool_end'
  | 'approval_request'
  | 'approval_response'
  | 'error'
  | 'session_start'
  | 'session_end'
  | 'compaction'
  | 'status'
  | 'usage';

/** Common fields present on every event payload. */
export interface AgentEvent {
  readonly type: EventType;
  readonly sessionId: SessionId;
  readonly timestamp: number;
}

/** Token-level streaming chunk from the model. */
export interface TokenEvent extends AgentEvent {
  readonly type: 'token';
  readonly text: string;
}

/** A new model message has begun streaming. */
export interface MessageStartEvent extends AgentEvent {
  readonly type: 'message_start';
  readonly role: 'user' | 'assistant';
}

/** The current model message has finished streaming. */
export interface MessageEndEvent extends AgentEvent {
  readonly type: 'message_end';
  readonly stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'error';
}

/** A tool invocation has started executing. */
export interface ToolStartEvent extends AgentEvent {
  readonly type: 'tool_start';
  readonly toolCall: ToolCall;
}

/** A tool invocation has finished (success, error, or denial). */
export interface ToolEndEvent extends AgentEvent {
  readonly type: 'tool_end';
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
}

/** The loop is asking the user to approve a risky action. */
export interface ApprovalRequestEvent extends AgentEvent {
  readonly type: 'approval_request';
  readonly request: PermissionRequest;
}

/** The user has decided on a pending approval request. */
export interface ApprovalResponseEvent extends AgentEvent {
  readonly type: 'approval_response';
  readonly request: PermissionRequest;
  readonly decision: PermissionDecision;
}

/** An error occurred in the loop. */
export interface ErrorEvent extends AgentEvent {
  readonly type: 'error';
  readonly error: string;
  /** When true, the session is being torn down. */
  readonly fatal: boolean;
}

/** A new session has been opened. */
export interface SessionStartEvent extends AgentEvent {
  readonly type: 'session_start';
  readonly model: string;
  readonly provider: string;
  readonly workingDir: string;
}

/** The session has ended. */
export interface SessionEndEvent extends AgentEvent {
  readonly type: 'session_end';
  readonly reason: 'completed' | 'interrupted' | 'error' | 'max_turns';
  readonly totalTokens: number;
  readonly duration: number;
}

/** A context-compaction pass has been performed. */
export interface CompactionEvent extends AgentEvent {
  readonly type: 'compaction';
  readonly level: 'micro' | 'auto' | 'full';
  readonly tokensBefore: number;
  readonly tokensAfter: number;
}

/** Coarse-grained loop status update. */
export interface StatusEvent extends AgentEvent {
  readonly type: 'status';
  readonly status: 'idle' | 'thinking' | 'waiting_approval' | 'executing';
  readonly detail?: string;
}

/** Token usage update emitted by the loop after a model call. */
export interface UsageEvent extends AgentEvent {
  readonly type: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /** Cost in USD, when the provider's pricing is known. */
  readonly estimatedCost?: number;
}

/** Discriminated union of every concrete event payload. */
export type AnyAgentEvent =
  | TokenEvent
  | MessageStartEvent
  | MessageEndEvent
  | ToolStartEvent
  | ToolEndEvent
  | ApprovalRequestEvent
  | ApprovalResponseEvent
  | ErrorEvent
  | SessionStartEvent
  | SessionEndEvent
  | CompactionEvent
  | StatusEvent
  | UsageEvent;

/** Type guard: does `e` carry a `token` payload? */
export function isTokenEvent(e: AnyAgentEvent): e is TokenEvent {
  return e.type === 'token';
}

/** Type guard: does `e` carry a `tool_start` or `tool_end` payload? */
export function isToolEvent(
  e: AnyAgentEvent,
): e is ToolStartEvent | ToolEndEvent {
  return e.type === 'tool_start' || e.type === 'tool_end';
}

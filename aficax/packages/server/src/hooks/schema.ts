// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\hooks\schema.ts
// Hook system types: events, definitions, context payloads, and replies.
//
// A hook is a small shell command (or any executable) that the Aficax
// server runs at well-defined points in the agent lifecycle. The server
// pipes a JSON context to the hook's stdin and parses a JSON reply from
// its stdout. The reply may request that the pending operation be blocked
// or that the context be modified before it reaches the agent.
//
// All hook definitions are user-supplied (no built-ins); the on-disk
// format mirrors the architecture document in
// `aficax-arquitectura.md` §9.

import type { SessionId } from '@aficax/core';
import type { ToolInput } from '@aficax/core';

/** Every lifecycle point at which a hook may run. */
export type HookEvent =
  | 'PreAPICall'
  | 'PostAPICall'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreUserPromptSubmit'
  | 'OnSessionStart'
  | 'OnSessionEnd'
  | 'OnError';

/** Static configuration of a single hook (one entry in `hooks.json`). */
export interface HookDefinition {
  readonly event: HookEvent;
  /** Shell command to execute. Tokenised with a POSIX-ish split. */
  readonly command: string;
  /** Maximum runtime in milliseconds. Defaults to 5 s. */
  readonly timeout: number;
  /**
   * What to do when the hook exits with a non-zero status, times out, or
   * prints invalid JSON. `abort` blocks the pending operation; `continue`
   * logs the failure and lets the operation proceed.
   */
  readonly onFailure: 'abort' | 'continue';
  /** When `false`, the hook is silently skipped. Defaults to `true`. */
  readonly enabled: boolean;
}

/** JSON payload the server writes to the hook's stdin. */
export type HookContext =
  | PreAPICallContext
  | PostAPICallContext
  | PreToolUseContext
  | PostToolUseContext
  | PreUserPromptSubmitContext
  | OnSessionStartContext
  | OnSessionEndContext
  | OnErrorContext;

/** Discriminated union of the `event` field carried by every payload. */
export interface BaseContext {
  readonly event: HookEvent;
  readonly sessionId: SessionId;
}

export interface PreAPICallContext extends BaseContext {
  readonly event: 'PreAPICall';
  readonly messageCount: number;
  readonly tokenEstimate: number;
  readonly model: string;
}

export interface PostAPICallContext extends BaseContext {
  readonly event: 'PostAPICall';
  readonly response: string;
  readonly tokenUsage: { readonly input: number; readonly output: number };
}

export interface PreToolUseContext extends BaseContext {
  readonly event: 'PreToolUse';
  readonly toolName: string;
  readonly input: ToolInput;
  readonly workingDir: string;
}

export interface PostToolUseContext extends BaseContext {
  readonly event: 'PostToolUse';
  readonly toolName: string;
  readonly input: ToolInput;
  readonly output: string;
  readonly durationMs: number;
  readonly isError: boolean;
}

export interface PreUserPromptSubmitContext extends BaseContext {
  readonly event: 'PreUserPromptSubmit';
  readonly prompt: string;
}

export interface OnSessionStartContext extends BaseContext {
  readonly event: 'OnSessionStart';
  readonly workingDir: string;
  readonly model: string;
  readonly provider: string;
}

export interface OnSessionEndContext extends BaseContext {
  readonly event: 'OnSessionEnd';
  readonly workingDir: string;
  readonly model: string;
  readonly totalTokens: number;
  readonly durationMs: number;
  readonly reason: 'completed' | 'interrupted' | 'error' | 'max_turns';
}

export interface OnErrorContext extends BaseContext {
  readonly event: 'OnError';
  readonly error: string;
  readonly stage: 'pre_api' | 'post_api' | 'pre_tool' | 'post_tool' | 'permission' | 'compaction' | 'other';
}

/** JSON reply a hook may print on stdout. Every field is optional. */
export interface HookReply {
  /** When `true`, the pending operation must be aborted. */
  readonly block?: boolean;
  /**
   * Replacement context. The dispatcher substitutes this object for the
   * original context before any downstream stage runs.
   */
  readonly modifiedContext?: unknown;
  /**
   * Optional human-readable reason attached to the block / modification.
   * Surfaced in the TUI and the error event.
   */
  readonly reason?: string;
}

/** Outcome of running every hook for a single event. */
export interface HookResult {
  /** True when at least one hook asked for the operation to be blocked. */
  readonly blocked: boolean;
  /**
   * Context the dispatcher settled on. Equal to the input context when
   * no hook modified it. Always set, even when `blocked` is `true` (the
   * caller can still inspect what the last successful hook saw).
   */
  readonly context: HookContext;
  /** First non-fatal reason any hook provided, when blocked. */
  readonly blockReason?: string;
  /** Errors that did not block execution (logged for observability). */
  readonly errors: readonly HookError[];
  /** Total wall-clock time spent running hooks for this event. */
  readonly durationMs: number;
}

/** One error from one hook that did not cause an abort. */
export interface HookError {
  readonly event: HookEvent;
  readonly command: string;
  readonly kind: 'timeout' | 'exit_nonzero' | 'invalid_json' | 'spawn_failed' | 'unknown';
  readonly message: string;
  readonly durationMs: number;
}

/** On-disk shape of `~/.aficax/hooks.json` (or the project-level copy). */
export interface HooksFile {
  readonly version?: number;
  readonly hooks: readonly HookDefinition[];
}

/** Default timeout applied when a hook omits it. */
export const DEFAULT_HOOK_TIMEOUT_MS = 5_000;

/** All hook event names, exposed for diagnostics and tests. */
export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreAPICall',
  'PostAPICall',
  'PreToolUse',
  'PostToolUse',
  'PreUserPromptSubmit',
  'OnSessionStart',
  'OnSessionEnd',
  'OnError',
];

/** Build a sane default {@link HookDefinition} from a partial input. */
export function normaliseHookDefinition(raw: unknown, fallbackEvent?: HookEvent): HookDefinition | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const event = obj['event'];
  if (typeof event !== 'string') {
    if (fallbackEvent === undefined) return null;
    return null;
  }
  if (!isHookEvent(event)) return null;
  if (fallbackEvent !== undefined && event !== fallbackEvent) return null;
  const command = obj['command'];
  if (typeof command !== 'string' || command.length === 0) return null;
  const timeoutRaw = obj['timeout'];
  const timeout = typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0
    ? Math.floor(timeoutRaw)
    : DEFAULT_HOOK_TIMEOUT_MS;
  const onFailureRaw = obj['onFailure'];
  const onFailure: 'abort' | 'continue' = onFailureRaw === 'continue' ? 'continue' : 'abort';
  const enabledRaw = obj['enabled'];
  const enabled = typeof enabledRaw === 'boolean' ? enabledRaw : true;
  return { event, command, timeout, onFailure, enabled };
}

/** Type guard: does `value` look like a valid {@link HookEvent}? */
export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === 'string' && (HOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Shape of a single hook registry entry at runtime. Mirrors
 * {@link HookDefinition} but exposes the resolved timeout in absolute ms
 * so the dispatcher does not need to know the default.
 */
export interface ResolvedHook extends HookDefinition {
  /** Source label for diagnostics. */
  readonly source: 'global' | 'project';
  /** Resolved timeout (after defaulting). */
  readonly timeoutMs: number;
}

// packages/tui/src/hooks/useStream.ts
// React hook that subscribes the TUI to a single `POST /sessions/:id/message`
// SSE stream and dispatches every event into the global Zustand store.
//
// The hook is intentionally short-lived: it is mounted by `App` when a user
// submits a message and torn down when the stream emits `session_end` or the
// caller aborts it.
//
// Event → store mapping (see the `dispatch` function):
//   session_start    → setSession
//   message_start    → append a new streaming message
//   token            → append chunk to the current streaming message
//   message_end      → finalize the current message
//   tool_start/end   → register / update a ToolCallRecord
//   approval_request → setPendingApproval (blocks the input bar)
//   approval_response→ clear pending approval
//   usage            → update the modelUsage slice
//   error / compaction → append a one-liner to the current message
//   session_end      → finalize the current message and clear approval

import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import type { AnyAgentEvent } from "@aficax/core";

import { AficaxClient } from "../client/api.js";
import { streamAgentEvents, SseError } from "../client/sse.js";
import {
  useTuiStore,
  type ChatMessage,
  type ToolCallRecord,
  type ToolCallStatus,
} from "../state/store.js";

/** Public configuration for {@link useStream}. */
export interface UseStreamOptions {
  /** Active session id. When `null` the hook stays idle. */
  readonly sessionId: string | null;
  /** API client used to negotiate the SSE handshake. */
  readonly client: AficaxClient;
  /**
   * Maximum number of reconnect attempts forwarded to the SSE generator.
   * Defaults to the SSE default of 3.
   */
  readonly maxReconnectAttempts?: number;
}

/** Return value of {@link useStream}. */
export interface UseStreamResult {
  /** Start streaming a new user message. Aborts any previous stream. */
  readonly send: (message: string) => Promise<void>;
  /** Abort the current stream (if any). */
  readonly interrupt: () => void;
  /** True while a stream is in flight. */
  readonly isStreaming: boolean;
  /** Text accumulated so far for the in-flight assistant message. */
  readonly pendingText: string;
  /**
   * Register a handler for approval requests arriving over the SSE
   * stream. Returns an unsubscribe function. Currently unused by the
   * TUI (approvals are surfaced via the store's pendingApproval slice)
   * but kept for forward compatibility.
   */
  readonly onApprovalRequest: (
    handler: (req: { readonly requestId: string; readonly toolName: string; readonly reason: string }) => void,
  ) => () => void;
}

/**
 * Convert a server-side `ToolCallStatus` string into the TUI's local union.
 * The server's `ToolCall` is a readonly type, so we copy the fields we need
 * into the store's mutable {@link ToolCallRecord}.
 */
function toTuiStatus(status: string): ToolCallStatus {
  switch (status) {
    case "pending":
    case "running":
    case "done":
    case "error":
    case "denied":
      return status;
    default:
      return "error";
  }
}

function makeMessageId(prefix: string): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${ts}-${rand}`;
}

/**
 * The hook itself. It owns an `AbortController` so that the parent component
 * can cancel the current stream at any time, and it routes every event into
 * the appropriate store action.
 *
 * Note: we do NOT push a placeholder message in `start()`; the agent's
 * first `message_start` event is the authoritative trigger for creating
 * a streaming message in the store. This avoids the duplicate-message bug
 * that would otherwise appear when the user submits a message.
 */
export function useStream(options: UseStreamOptions): UseStreamResult {
  const { sessionId, client, maxReconnectAttempts } = options;
  const isStreaming = useTuiStore((s) => s.isStreaming);
  const setStreaming = useTuiStore((s) => s.setStreaming);
  const addMessage = useTuiStore((s) => s.addMessage);
  const appendToMessage = useTuiStore((s) => s.appendToMessage);
  const finalizeMessage = useTuiStore((s) => s.finalizeMessage);
  const startToolCall = useTuiStore((s) => s.startToolCall);
  const updateToolCall = useTuiStore((s) => s.updateToolCall);
  const setPendingApproval = useTuiStore((s) => s.setPendingApproval);
  const setModelUsage = useTuiStore((s) => s.setModelUsage);
  const setSession = useTuiStore((s) => s.setSession);

  const controllerRef = useRef<AbortController | null>(null);
  const currentMessageIdRef = useRef<string | null>(null);
  const pendingTextRef = useRef<string>("");
  const [pendingText, setPendingText] = useState<string>("");
  const approvalHandlersRef = useRef<Set<(req: { requestId: string; toolName: string; reason: string }) => void>>(
    new Set(),
  );

  const interrupt = useCallback((): void => {
    if (controllerRef.current) {
      controllerRef.current.abort();
      controllerRef.current = null;
    }
    currentMessageIdRef.current = null;
    pendingTextRef.current = "";
    setPendingText("");
    setStreaming(false);
  }, [setStreaming]);

  const onApprovalRequest = useCallback(
    (
      handler: (req: { readonly requestId: string; readonly toolName: string; readonly reason: string }) => void,
    ): (() => void) => {
      approvalHandlersRef.current.add(handler);
      return () => {
        approvalHandlersRef.current.delete(handler);
      };
    },
    [],
  );

  const send = useCallback(
    async (message: string): Promise<void> => {
      if (!sessionId) return;
      if (isStreaming) {
        // Abort the previous stream first so we never have two open at once.
        if (controllerRef.current) {
          controllerRef.current.abort();
        }
      }

      const controller = new AbortController();
      controllerRef.current = controller;
      currentMessageIdRef.current = null;

      // Mark the stream as live immediately so the InputBar can show the
      // "streaming…" hint. The actual agent message is created on the first
      // `message_start` event.
      setStreaming(true, null);

      const streamOpts: Parameters<typeof streamAgentEvents>[2] = {
        signal: controller.signal,
        ...(maxReconnectAttempts !== undefined ? { maxAttempts: maxReconnectAttempts } : {}),
      };

      void runStream({
        client,
        sessionId,
        message,
        controller,
        handlers: {
          addMessage,
          appendToMessage,
          finalizeMessage,
          startToolCall,
          updateToolCall,
          setPendingApproval,
          setModelUsage,
          setSession,
          setStreaming,
          appendPendingText: (chunk: string): void => {
            pendingTextRef.current += chunk;
            setPendingText(pendingTextRef.current);
          },
          resetPendingText: (): void => {
            pendingTextRef.current = "";
            setPendingText("");
          },
          fireApproval: (req: { requestId: string; toolName: string; reason: string }): void => {
            for (const h of approvalHandlersRef.current) h(req);
          },
        },
        currentMessageIdRef,
        options: streamOpts,
      })
        .catch((err: unknown) => {
          const text =
            err instanceof SseError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          const target = currentMessageIdRef.current;
          if (target) {
            appendToMessage(target, `\n\n[stream error] ${text}`);
            finalizeMessage(target);
          } else {
            addMessage({
              id: makeMessageId("sys"),
              role: "system",
              content: `[stream error] ${text}`,
              timestamp: Date.now(),
            });
          }
        })
        .finally(() => {
          if (controllerRef.current === controller) {
            controllerRef.current = null;
          }
          if (currentMessageIdRef.current !== null) {
            currentMessageIdRef.current = null;
          }
          pendingTextRef.current = "";
          setPendingText("");
          setStreaming(false);
        });
    },
    [
      sessionId,
      isStreaming,
      client,
      maxReconnectAttempts,
      addMessage,
      appendToMessage,
      finalizeMessage,
      startToolCall,
      updateToolCall,
      setPendingApproval,
      setModelUsage,
      setSession,
      setStreaming,
    ],
  );

  // Tear the stream down when the hook unmounts.
  useEffect(() => {
    return () => {
      if (controllerRef.current) {
        controllerRef.current.abort();
        controllerRef.current = null;
      }
    };
  }, []);

  return { send, interrupt, isStreaming, pendingText, onApprovalRequest };
}

// -- Internals ------------------------------------------------------------

interface Handlers {
  addMessage: (msg: ChatMessage) => void;
  appendToMessage: (id: string, chunk: string) => void;
  finalizeMessage: (id: string) => void;
  startToolCall: (record: ToolCallRecord) => void;
  appendPendingText: (chunk: string) => void;
  resetPendingText: () => void;
  fireApproval: (req: { requestId: string; toolName: string; reason: string }) => void;
  updateToolCall: (id: string, patch: Partial<ToolCallRecord>) => void;
  setPendingApproval: (
    req: ReturnType<typeof useTuiStore.getState>["pendingApproval"],
  ) => void;
  setModelUsage: (usage: ReturnType<typeof useTuiStore.getState>["modelUsage"]) => void;
  setSession: (session: ReturnType<typeof useTuiStore.getState>["session"]) => void;
  setStreaming: (
    streaming: boolean,
    currentId?: string | null,
  ) => void;
}

interface RunStreamArgs {
  client: AficaxClient;
  sessionId: string;
  message: string;
  controller: AbortController;
  handlers: Handlers;
  currentMessageIdRef: MutableRefObject<string | null>;
  options: Parameters<typeof streamAgentEvents>[2];
}

async function runStream(args: RunStreamArgs): Promise<void> {
  for await (const event of streamAgentEvents(
    args.client,
    { sessionId: args.sessionId, message: args.message },
    args.options,
  )) {
    if (args.controller.signal.aborted) return;
    dispatch(args.handlers, event, args.currentMessageIdRef);
    if (event.type === "session_end") {
      return;
    }
  }
}

function dispatch(
  h: Handlers,
  event: AnyAgentEvent,
  currentMessageIdRef: MutableRefObject<string | null>,
): void {
  switch (event.type) {
    case "session_start": {
      h.setSession({
        id: event.sessionId,
        workingDir: event.workingDir,
        model: event.model,
        provider: event.provider,
        createdAt: event.timestamp,
        mode: "auto",
      });
      return;
    }
    case "message_start": {
      // Create the streaming message right when the agent begins emitting
      // tokens. We give it a fresh id and record it in the ref so subsequent
      // `token` events know where to append.
      const id = makeMessageId("msg");
      currentMessageIdRef.current = id;
      h.addMessage({
        id,
        role: "assistant",
        content: "",
        timestamp: event.timestamp,
        streaming: true,
        toolCalls: [],
      });
      h.setStreaming(true, id);
      h.resetPendingText();
      return;
    }
    case "token": {
      const id = currentMessageIdRef.current;
      if (id === null) {
        // Defensive: tokens arrived before a `message_start`. Buffer them
        // by lazily creating a streaming message so they are not lost.
        const fallbackId = makeMessageId("msg");
        currentMessageIdRef.current = fallbackId;
        h.addMessage({
          id: fallbackId,
          role: "assistant",
          content: event.text,
          timestamp: event.timestamp,
          streaming: true,
          toolCalls: [],
        });
        h.setStreaming(true, fallbackId);
        h.appendPendingText(event.text);
        return;
      }
      h.appendToMessage(id, event.text);
      h.appendPendingText(event.text);
      return;
    }
    case "message_end": {
      const id = currentMessageIdRef.current;
      if (id !== null) {
        h.finalizeMessage(id);
        currentMessageIdRef.current = null;
      }
      return;
    }
    case "tool_start": {
      h.startToolCall({
        id: event.toolCall.id,
        name: event.toolCall.toolName,
        input: event.toolCall.input,
        status: toTuiStatus(event.toolCall.status),
        startedAt: event.timestamp,
      });
      return;
    }
    case "tool_end": {
      const patch: Partial<ToolCallRecord> = {
        status: toTuiStatus(event.toolCall.status),
        finishedAt: event.timestamp,
      };
      if (event.toolCall.output !== undefined) {
        patch.output = event.toolCall.output;
      }
      if (event.toolCall.errorMessage !== undefined) {
        patch.errorMessage = event.toolCall.errorMessage;
      }
      h.updateToolCall(event.toolCall.id, patch);
      return;
    }
    case "approval_request": {
      h.setPendingApproval({
        id: `${event.sessionId}:${String(event.timestamp)}`,
        toolName: event.request.toolName,
        input: event.request.input,
        riskLevel: event.request.risk,
        description: event.request.reason,
      });
      return;
    }
    case "approval_response": {
      // Loop is moving on — clear the prompt so the InputBar is unblocked.
      h.setPendingApproval(null);
      return;
    }
    case "error": {
      const id = currentMessageIdRef.current;
      const text = `\n\n[error] ${event.error}${event.fatal ? " (fatal)" : ""}`;
      if (id !== null) {
        h.appendToMessage(id, text);
        if (event.fatal) h.finalizeMessage(id);
      } else {
        h.addMessage({
          id: makeMessageId("sys"),
          role: "system",
          content: text.trim(),
          timestamp: event.timestamp,
        });
      }
      return;
    }
    case "status": {
      // Coarse-grained status — the InputBar reads `isStreaming` directly.
      return;
    }
    case "usage": {
      h.setModelUsage({
        used: event.totalTokens,
        limit: useTuiStore.getState().modelUsage.limit,
      });
      return;
    }
    case "compaction": {
      const id = currentMessageIdRef.current;
      const line = `\n\n[compaction:${event.level}] ${String(event.tokensBefore)} → ${String(event.tokensAfter)} tokens`;
      if (id !== null) {
        h.appendToMessage(id, line);
      } else {
        h.addMessage({
          id: makeMessageId("sys"),
          role: "system",
          content: line.trim(),
          timestamp: event.timestamp,
        });
      }
      return;
    }
    case "session_end": {
      const id = currentMessageIdRef.current;
      if (id !== null) {
        h.finalizeMessage(id);
        currentMessageIdRef.current = null;
      }
      h.setPendingApproval(null);
      return;
    }
  }
}

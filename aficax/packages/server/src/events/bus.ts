// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\events\bus.ts
// In-process pub/sub used by the SSE endpoint to fan out agent events to
// every client currently subscribed to a given session.

import { getLogger, type AnyAgentEvent, type PermissionDecision, type PermissionRequest, type SessionId } from '@aficax/core';

const logger = getLogger();

/** A single SSE client connection. `send` is invoked for every event. */
export interface SSEConnection {
  send(event: AnyAgentEvent): void | Promise<void>;
  close(): void;
}

/** In-memory event bus, keyed by session id. */
export class EventBus {
  private readonly connections: Map<SessionId, Set<SSEConnection>> = new Map();

  /** Register `connection` as a subscriber of `sessionId`. */
  subscribe(sessionId: SessionId, connection: SSEConnection): void {
    const existing = this.connections.get(sessionId);
    if (existing) {
      existing.add(connection);
      return;
    }
    const set = new Set<SSEConnection>();
    set.add(connection);
    this.connections.set(sessionId, set);
  }

  /** Remove `connection` from the subscribers of `sessionId`. */
  unsubscribe(sessionId: SessionId, connection: SSEConnection): void {
    const existing = this.connections.get(sessionId);
    if (!existing) {
      return;
    }
    existing.delete(connection);
    if (existing.size === 0) {
      this.connections.delete(sessionId);
    }
  }

  /**
   * Deliver `event` to every subscriber of `sessionId`. Individual send
   * failures are swallowed so a misbehaving client cannot break delivery
   * to the rest of the subscribers.
   */
  publish(sessionId: SessionId, event: AnyAgentEvent): void {
    const set = this.connections.get(sessionId);
    if (!set) {
      return;
    }
    for (const connection of set) {
      try {
        const result = connection.send(event);
        if (this.isPromise(result)) {
          result.catch(() => {
            /* swallow delivery errors */
          });
        }
      } catch {
        /* swallow synchronous send errors */
      }
    }
  }

  /** Number of active subscribers for a given session (0 if none). */
  subscriberCount(sessionId: SessionId): number {
    return this.connections.get(sessionId)?.size ?? 0;
  }

  /** Total number of active SSE connections across every session. */
  totalConnections(): number {
    let total = 0;
    for (const set of this.connections.values()) {
      total += set.size;
    }
    return total;
  }

  /** Close and forget every active connection. Used during shutdown. */
  closeAll(): void {
    for (const set of this.connections.values()) {
      for (const conn of set) {
        try {
          conn.close();
        } catch {
          /* ignore */
        }
      }
    }
    this.connections.clear();
  }

  private isPromise(value: unknown): value is Promise<unknown> {
    return (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as { then?: unknown }).then === 'function'
    );
  }
}

/** Factory that creates a fresh {@link EventBus}. */
export function createEventBus(): EventBus {
  return new EventBus();
}

// -------------------------------------------------------------------------
// PendingApprovals
// -------------------------------------------------------------------------

/** Outcome of waiting on a permission approval. */
export type ApprovalOutcome =
  | { readonly auto: false; readonly decision: PermissionDecision }
  | { readonly auto: true; readonly decision: PermissionDecision; readonly reason: 'timeout' | 'aborted' };

/** Internal record for a single pending approval. */
interface PendingEntry {
  readonly createdAt: number;
  readonly request: PermissionRequest;
  resolve(value: ApprovalOutcome): void;
}

/** Default timeout for an approval request when none is supplied. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Registry of in-flight permission approvals.
 *
 * The `QueryEngine` calls {@link PendingApprovals.register} before emitting
 * an `ApprovalRequestEvent` so that, if the TUI responds quickly, the
 * response can be matched to the right promise. The HTTP route that
 * receives the `POST /sessions/:id/approve` body calls {@link
 * PendingApprovals.resolve} to fulfil the promise.
 *
 * Each registered promise has a hard timeout (5 minutes by default). If
 * the timer fires before the TUI responds the promise resolves with
 * `auto: true` and `decision: 'deny'` — the loop then treats the tool call
 * as denied and reports a synthetic tool result to the model.
 */
export class PendingApprovals {
  private readonly pending: Map<string, PendingEntry> = new Map();

  /**
   * Wait for a decision for `approvalId`. The returned promise:
   *   - resolves with `{auto: false, decision}` when {@link resolve} is called
   *   - resolves with `{auto: true, decision: 'deny', reason: 'timeout'}`
   *     when `timeoutMs` elapses without a response
   *   - resolves with `{auto: true, decision: 'deny', reason: 'aborted'}`
   *     when `signal` aborts before a response arrives
   *
   * The same `approvalId` cannot be registered twice; the second call
   * throws so the loop fails loudly rather than silently overwriting the
   * first waiter.
   */
  register(
    approvalId: string,
    request: PermissionRequest,
    timeoutMs: number = DEFAULT_APPROVAL_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<ApprovalOutcome> {
    if (this.pending.has(approvalId)) {
      throw new Error(`Approval "${approvalId}" is already pending`);
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false;
      const entry: PendingEntry = {
        createdAt: Date.now(),
        request,
        resolve: (value) => {
          if (settled) return;
          settled = true;
          this.pending.delete(approvalId);
          cleanup();
          resolve(value);
        },
      };

      const timer = setTimeout(() => {
        if (settled) return;
        logger.warn('Approval timed out, auto-denying', {
          approvalId,
          toolName: request.toolName,
          sessionId: request.sessionId,
        });
        entry.resolve({
          auto: true,
          decision: 'deny',
          reason: 'timeout',
        });
      }, Math.max(1, timeoutMs));

      const onAbort = (): void => {
        if (settled) return;
        logger.info('Approval aborted by signal, auto-denying', {
          approvalId,
          toolName: request.toolName,
          sessionId: request.sessionId,
        });
        entry.resolve({
          auto: true,
          decision: 'deny',
          reason: 'aborted',
        });
      };

      function cleanup(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }

      if (signal !== undefined) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      this.pending.set(approvalId, entry);
    });
  }

  /**
   * Resolve the pending approval for `approvalId` with `decision`.
   * Returns `true` if a pending entry was found and resolved, `false`
   * otherwise (caller can use this to detect expired/timed-out ids).
   */
  resolve(approvalId: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    entry.resolve({ auto: false, decision });
    return true;
  }

  /** Cancel every pending approval, resolving them as auto-denied. */
  cancelAll(reason: 'aborted' | 'timeout' = 'aborted'): void {
    for (const [id, entry] of this.pending) {
      entry.resolve({ auto: true, decision: 'deny', reason });
    }
    this.pending.clear();
  }

  /** Number of currently-pending approvals. */
  size(): number {
    return this.pending.size;
  }

  /** Snapshot of pending approval ids. Used by the /health endpoint. */
  pendingIds(): readonly string[] {
    return Array.from(this.pending.keys());
  }

  /** Inspect the request associated with an in-flight approval. */
  peek(approvalId: string): PermissionRequest | undefined {
    return this.pending.get(approvalId)?.request;
  }
}

/** Factory that creates a fresh {@link PendingApprovals}. */
export function createPendingApprovals(): PendingApprovals {
  return new PendingApprovals();
}

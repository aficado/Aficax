// packages/tui/src/client/sse.ts
// Server-Sent Events client for the Aficax TUI.
//
// The server uses Hono's `streamSSE` on `POST /sessions/:id/message`, which
// streams back the `AnyAgentEvent` payloads produced by the agent loop. This
// module wraps that endpoint in an `AsyncGenerator<AnyAgentEvent>` and handles:
//   - line-by-line parsing of the `text/event-stream` wire format
//   - automatic reconnection with exponential backoff (max 3 attempts)
//   - clean shutdown when a `session_end` event is observed
//   - a single `AbortSignal` that propagates user-initiated cancellation

import type { AnyAgentEvent } from "@aficax/core";

import type { AficaxClient } from "./api.js";

/** Default reconnection parameters (also exported so callers can tweak). */
export const SSE_DEFAULTS = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 4_000,
} as const;

/** Optional tuning for {@link streamAgentEvents}. */
export interface StreamOptions {
  /** Hard limit on reconnect attempts. Defaults to {@link SSE_DEFAULTS.maxAttempts}. */
  readonly maxAttempts?: number;
  /** Base delay for the exponential backoff. Defaults to 500ms. */
  readonly baseDelayMs?: number;
  /** Upper bound for any individual backoff sleep. Defaults to 4s. */
  readonly maxDelayMs?: number;
  /** Pre-built signal to abort the stream. */
  readonly signal?: AbortSignal;
}

/** Payload required to start a streaming connection. */
export interface StreamRequest {
  readonly sessionId: string;
  readonly message: string;
}

/** Anything that can be thrown by the SSE layer. */
export class SseError extends Error {
  public override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SseError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * Open an SSE connection to `POST /sessions/:id/message` and yield every
 * `AnyAgentEvent` the server emits. The generator terminates when:
 *   - the server emits a `session_end` event (clean shutdown)
 *   - the caller aborts the supplied `signal`
 *   - the maximum number of reconnect attempts is exhausted
 *   - a non-recoverable protocol or network error occurs
 */
export async function* streamAgentEvents(
  client: AficaxClient,
  request: StreamRequest,
  options: StreamOptions = {},
): AsyncGenerator<AnyAgentEvent> {
  const maxAttempts = options.maxAttempts ?? SSE_DEFAULTS.maxAttempts;
  const baseDelay = options.baseDelayMs ?? SSE_DEFAULTS.baseDelayMs;
  const maxDelay = options.maxDelayMs ?? SSE_DEFAULTS.maxDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted === true) {
      return;
    }

    let sawEnd = false as boolean | undefined;
    let protocolError: unknown = null;

    try {
      const connection = await openConnection(client, request, options.signal);
      try {
        for await (const event of parseEventStream(connection.body)) {
          if (options.signal?.aborted) {
            return;
          }
          yield event;
          if (event.type === "session_end") {
            sawEnd = true;
            return;
          }
        }
      } finally {
        try {
          await connection.body.cancel();
        } catch {
          /* stream may already be closed */
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return;
      }
      if (sawEnd) {
        return;
      }
      protocolError = err;
    }

    if (attempt >= maxAttempts) {
      if (protocolError !== null) {
        throw new SseError(
          `SSE stream failed after ${String(maxAttempts)} attempts`,
          protocolError,
        );
      }
      return;
    }

    const wait = Math.min(maxDelay, baseDelay * 2 ** (attempt - 1));
    await sleep(wait, options.signal);
  }
}

// -- Internals ------------------------------------------------------------

interface SseConnection {
  readonly body: ReadableStream<Uint8Array>;
  readonly response: Response;
}

async function openConnection(
  client: AficaxClient,
  request: StreamRequest,
  externalSignal: AbortSignal | undefined,
): Promise<SseConnection> {
  const url = `${client.getBaseUrl()}/sessions/${encodeURIComponent(request.sessionId)}/message`;
  const controller = new AbortController();
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort(externalSignal.reason);
    } else {
      externalSignal.addEventListener(
        "abort",
        () => controller.abort(externalSignal.reason),
        { once: true },
      );
    }
  }

  // We bypass `AficaxClient.request` here because the SSE endpoint keeps the
  // connection open and streams events, so we need direct access to the
  // response body. The fetch implementation is captured at call time so the
  // function remains testable with a mocked fetch.
  const fetchImpl: typeof fetch =
    typeof globalThis.fetch === "function"
      ? (globalThis.fetch as typeof fetch).bind(globalThis)
      : (() => {
          throw new SseError("global fetch is not available in this runtime");
        })();

  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ message: request.message }),
      signal: controller.signal,
    };
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new SseError(
      err instanceof Error ? `fetch failed: ${err.message}` : String(err),
      err,
    );
  }

  if (!response.ok) {
    controller.abort();
    throw new SseError(
      `SSE handshake failed: ${String(response.status)} ${response.statusText}`,
    );
  }
  if (response.body === null) {
    controller.abort();
    throw new SseError("SSE response has no body");
  }
  return { body: response.body, response };
}

/**
 * Parse a `text/event-stream` body into a stream of decoded `AnyAgentEvent`
 * payloads. Implements the minimum of the SSE spec that Hono's `streamSSE`
 * uses: a record is terminated by a blank line and consists of
 * `field: value` lines. Comments (lines starting with `:`) and unknown
 * fields are ignored.
 */
async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnyAgentEvent> {
  const decoder = new TextDecoder("utf-8");
  const reader = body.getReader();

  let buffer = "";
  let dataLines: string[] = [];
  let eventName = "message";
  const pending: AnyAgentEvent[] = [];

  const flush = (): AnyAgentEvent | null => {
    if (dataLines.length === 0) {
      eventName = "message";
      return null;
    }
    const data = dataLines.join("\n");
    const name = eventName;
    dataLines = [];
    eventName = "message";
    if (data.length === 0) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch (err) {
      throw new SseError(
        `failed to parse SSE data payload as JSON (event=${name}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }
    if (!isAgentEventLike(parsed)) {
      throw new SseError(
        `SSE payload is not a valid AgentEvent (event=${name})`,
      );
    }
    return parsed;
  };

  const applyField = (field: string, payload: string): void => {
    switch (field) {
      case "event":
        eventName = payload;
        return;
      case "data":
        dataLines.push(payload);
        return;
      case "id":
      case "retry":
        // Hono populates `id` with the event timestamp; we do not need it
        // because the parsed payload already carries `timestamp`.
        return;
      default:
        return;
    }
  };

  const handleLine = (line: string): void => {
    if (line.length === 0) {
      const ev = flush();
      if (ev) pending.push(ev);
      return;
    }
    if (line.startsWith(":")) {
      // SSE comment — ignore per the spec.
      return;
    }
    const colonAt = line.indexOf(":");
    if (colonAt === -1) {
      applyField(line, "");
      return;
    }
    const field = line.slice(0, colonAt);
    let payload = line.slice(colonAt + 1);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    applyField(field, payload);
  };

  const drainPending = (): AnyAgentEvent | null => {
    if (pending.length === 0) return null;
    return pending.shift() ?? null;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        for (const raw of buffer.split(/\r?\n/)) {
          handleLine(raw);
        }
        const tail = drainPending();
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const raw = buffer.slice(0, newlineAt).replace(/\r$/, "");
        buffer = buffer.slice(newlineAt + 1);
        handleLine(raw);
        const ev = drainPending();
        if (ev) yield ev;
        newlineAt = buffer.indexOf("\n");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

function isAgentEventLike(value: unknown): value is AnyAgentEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj["type"] !== "string") return false;
  if (typeof obj["sessionId"] !== "string") return false;
  if (typeof obj["timestamp"] !== "number") return false;
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

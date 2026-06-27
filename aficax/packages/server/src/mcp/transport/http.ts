// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\mcp\transport\http.ts
// HTTP/SSE transport for the Model Context Protocol.
//
// The MCP "Streamable HTTP" transport (2025-03-26 spec) accepts POST
// requests whose body is a single JSON-RPC 2.0 envelope. The server may
// respond in one of two ways:
//
//   1. `Content-Type: application/json` — a single JSON object (success
//      response or error).
//   2. `Content-Type: text/event-stream` — an SSE stream carrying one or
//      more JSON-RPC frames (the first frame answers the request, any
//      additional frames are server-initiated notifications).
//
// This transport supports both shapes and is fully async-iterator based
// for the SSE branch.

import { getLogger, type McpServerConfig } from '@aficax/core';

import {
  StdioTransportError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type NotificationHandler,
} from './stdio.js';

const logger = getLogger();

/** Public configuration of the HTTP transport. */
export interface HttpMcpTransportOptions {
  readonly config: McpServerConfig;
  /** Per-request timeout in milliseconds (default 30 s). */
  readonly requestTimeoutMs?: number;
  /** Optional handler for notifications. */
  readonly onNotification?: NotificationHandler;
  /**
   * Inject a custom fetch implementation (tests). Defaults to
   * `globalThis.fetch`. The implementation MUST follow the Fetch API.
   */
  readonly fetchImpl?: typeof fetch;
}

/** Error raised by the HTTP transport. */
export class HttpTransportError extends Error {
  public readonly code: number | string;
  constructor(message: string, code: number | string = 'http_error') {
    super(message);
    this.name = 'HttpTransportError';
    this.code = code;
  }
}

/** HTTP/SSE transport. */
export class HttpMcpTransport {
  private readonly config: McpServerConfig;
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: NotificationHandler;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;
  private connectedFlag = false;

  constructor(options: HttpMcpTransportOptions) {
    this.config = options.config;
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.config.timeout ?? 30_000;
    if (options.onNotification !== undefined) {
      this.onNotification = options.onNotification;
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** Always true after construction — the HTTP transport has no persistent connection. */
  isConnected(): boolean {
    return this.connectedFlag;
  }

  /**
   * Mark the transport as connected. The actual handshake is performed
   * lazily on the first request — this matches the MCP spec which does
   * not require a separate "connect" call for HTTP transports.
   */
  async connect(): Promise<void> {
    if (this.config.type !== 'http' || typeof this.config.url !== 'string' || this.config.url.length === 0) {
      throw new HttpTransportError(
        `MCP server "${this.config.name}" is missing a "url" for http transport`,
        'invalid_config',
      );
    }
    this.connectedFlag = true;
    logger.debug('http transport ready', { server: this.config.name, url: this.config.url });
  }

  async disconnect(): Promise<void> {
    this.connectedFlag = false;
  }

  /** Send a JSON-RPC request and await the matching response. */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connectedFlag) {
      throw new HttpTransportError('transport is not connected');
    }
    const id = this.nextId++;
    const envelope: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    const url = this.config.url;
    if (typeof url !== 'string') {
      throw new HttpTransportError('http transport requires a url', 'invalid_config');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.max(1, this.requestTimeoutMs));

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpTransportError) throw err;
      if (err instanceof StdioTransportError) throw err;
      throw new HttpTransportError(
        err instanceof Error ? `fetch failed: ${err.message}` : String(err),
        'fetch_error',
      );
    }

    try {
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new HttpTransportError(
          `http request failed: ${String(response.status)} ${response.statusText} ${text}`,
          response.status,
        );
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        return (await this.collectSseResult(response, id, controller.signal)) as T;
      }
      const text = await response.text();
      return parseJsonRpcResult(text, id) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Send a JSON-RPC notification. The MCP HTTP spec allows notifications
   * via POST as well; the server is expected to reply with `202 Accepted`
   * (no body).
   */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.connectedFlag) {
      throw new HttpTransportError('transport is not connected');
    }
    const url = this.config.url;
    if (typeof url !== 'string') {
      throw new HttpTransportError('http transport requires a url', 'invalid_config');
    }
    const envelope: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, this.requestTimeoutMs));
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(envelope),
        signal: controller.signal,
      });
      // Best-effort: drain so the connection can be released.
      await response.text().catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Read an SSE stream until a frame answers the request (matching `id`)
   * or the stream ends. Any additional notifications are routed through
   * `onNotification` while we wait.
   */
  private async collectSseResult(
    response: Response,
    id: number,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!response.body) {
      throw new HttpTransportError('SSE response has no body', 'no_body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    // Mutable box the inner callback writes to; the loop reads from it
    // after each consumed line.
    const resolved: { value: unknown } = { value: undefined };

    const cleanup = (): void => {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    };

    try {
      while (true) {
        if (signal.aborted) {
          throw new HttpTransportError('aborted', 'aborted');
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new HttpTransportError(
            `SSE stream closed before a response for id ${String(id)} arrived`,
            'premature_close',
          );
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const raw = buffer.slice(0, newlineAt).replace(/\r$/, '');
          buffer = buffer.slice(newlineAt + 1);
          this.consumeSseLine(raw, (payload) => {
            const parsed = parseSsePayload(payload);
            if (parsed === null) return;
            const handled = this.handleFrame(parsed, id);
            if (handled !== undefined) {
              resolved.value = handled;
            }
          });
          if (resolved.value !== undefined) {
            cleanup();
            return resolved.value;
          }
          newlineAt = buffer.indexOf('\n');
        }
      }
    } finally {
      cleanup();
    }
  }

  /**
   * Handle a single JSON-RPC frame. Returns the result when the frame
   * answers `id`; otherwise dispatches the frame as a notification.
   * The `undefined` return signals "keep reading".
   */
  private handleFrame(parsed: unknown, id: number): unknown {
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const obj = parsed as Record<string, unknown>;
    const frameId = obj['id'];
    const hasId = frameId !== undefined && frameId !== null;
    if (!hasId) {
      const method = obj['method'];
      if (typeof method === 'string') {
        try {
          this.onNotification?.(method, obj['params']);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.debug('notification handler threw', { method, error: message });
        }
      }
      return undefined;
    }
    if (Number(frameId) !== id) {
      // A response for a different request — discard.
      return undefined;
    }
    if (obj['error'] !== undefined && obj['error'] !== null && typeof obj['error'] === 'object') {
      const errObj = obj['error'] as { code?: unknown; message?: unknown };
      const code = typeof errObj.code === 'number' ? errObj.code : 'jsonrpc_error';
      const message = typeof errObj.message === 'string' ? errObj.message : 'JSON-RPC error';
      throw new HttpTransportError(message, code);
    }
    return obj['result'];
  }

  /**
   * Walk the SSE buffer line by line. `onPayload` is invoked with the
   * payload of every complete `data:` block.
   */
  private consumeSseLine(
    line: string,
    onPayload: (payload: string) => void,
  ): void {
    if (line.length === 0) {
      // Blank line terminates an event; ignore — we are frame-oriented,
      // not event-oriented.
      return;
    }
    if (line.startsWith(':')) {
      // SSE comment.
      return;
    }
    const colonAt = line.indexOf(':');
    if (colonAt === -1) {
      // Field with no value (e.g. just "data"); treat as empty data.
      onPayload('');
      return;
    }
    const field = line.slice(0, colonAt);
    let payload = line.slice(colonAt + 1);
    if (payload.startsWith(' ')) payload = payload.slice(1);
    if (field === 'data') {
      onPayload(payload);
    }
  }
}

// -- Helpers --------------------------------------------------------------

/** Parse the body of a JSON response and pick the `result` for `id`. */
function parseJsonRpcResult(raw: string, id: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new HttpTransportError(`invalid JSON in response: ${message}`, 'invalid_json');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new HttpTransportError('JSON-RPC response is not an object', 'invalid_json');
  }
  const obj = parsed as Record<string, unknown>;
  if (Number(obj['id']) !== id) {
    throw new HttpTransportError(
      `response id ${String(obj['id'])} does not match request id ${String(id)}`,
      'id_mismatch',
    );
  }
  if (obj['error'] !== undefined && obj['error'] !== null && typeof obj['error'] === 'object') {
    const errObj = obj['error'] as { code?: unknown; message?: unknown };
    const code = typeof errObj.code === 'number' ? errObj.code : 'jsonrpc_error';
    const message = typeof errObj.message === 'string' ? errObj.message : 'JSON-RPC error';
    throw new HttpTransportError(message, code);
  }
  return obj['result'];
}

/** Parse a single SSE `data:` payload as JSON. Returns `null` on `[DONE]`. */
function parseSsePayload(payload: string): unknown {
  if (payload.length === 0) return null;
  if (payload === '[DONE]') return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** Factory that creates an HTTP transport for a given config. */
export function createHttpMcpTransport(options: HttpMcpTransportOptions): HttpMcpTransport {
  return new HttpMcpTransport(options);
}

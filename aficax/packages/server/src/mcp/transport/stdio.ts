// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\mcp\transport\stdio.ts
// STDIO transport for the Model Context Protocol.
//
// MCP servers are typically distributed as standalone binaries that speak
// JSON-RPC 2.0 over newline-delimited JSON on their stdin / stdout. This
// transport:
//
//   1. Spawns the configured `command` via `Bun.spawn` with merged env.
//   2. Pumps stdout line by line, parsing each as a JSON-RPC frame.
//   3. Routes responses back to the matching pending request by `id`.
//   4. Dispatches notifications (frames without an `id`) to a listener.
//   5. Tears the subprocess down cleanly on `disconnect()`, including
//      killing the entire process group on POSIX so the child can't outlive
//      its parent.

import { getLogger, type McpServerConfig } from '@aficax/core';

const logger = getLogger();

/** JSON-RPC 2.0 error object (subset used by MCP). */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Successful JSON-RPC 2.0 response. */
export interface JsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result: unknown;
}

/** Failed JSON-RPC 2.0 response. */
export interface JsonRpcErrorResponse {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly error: JsonRpcError;
}

/** Discriminated union of every JSON-RPC 2.0 response shape. */
export type JsonRpcResponseOrError = JsonRpcResponse | JsonRpcErrorResponse;

/** JSON-RPC 2.0 request envelope. */
export interface JsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** JSON-RPC 2.0 notification (no `id` — no response expected). */
export interface JsonRpcNotification {
  readonly jsonrpc: '2.0';
  readonly method: string;
  readonly params?: unknown;
}

/** Inbound frame parsed from the server's stdout. */
export type InboundFrame = JsonRpcResponseOrError | JsonRpcNotification;

/** Single in-flight request waiting on a reply. */
interface PendingRequest {
  readonly id: number;
  resolve(value: unknown): void;
  reject(reason: Error): void;
  /** AbortController for the per-request timeout. */
  readonly controller: AbortController;
}

/** Notification handler subscribed via {@link StdioMcpTransport.onNotification}. */
export type NotificationHandler = (method: string, params: unknown) => void;

/** Public configuration of the STDIO transport. */
export interface StdioMcpTransportOptions {
  /** Full MCP server configuration (only the stdio fields are used). */
  readonly config: McpServerConfig;
  /** Per-request timeout in milliseconds (default 30 s). */
  readonly requestTimeoutMs?: number;
  /** Optional handler for notifications (e.g. `notifications/tools/list_changed`). */
  readonly onNotification?: NotificationHandler;
  /**
   * Inject a custom process spawner (tests). Defaults to {@link defaultSpawn}.
   */
  readonly spawn?: SpawnFn;
}

/** Returned by a {@link SpawnFn} — a minimal handle over the child process. */
export interface SpawnHandle {
  /** Write a line to the child's stdin (no trailing newline). */
  writeLine(line: string): Promise<void>;
  /** Read stdout as an async iterable of lines. */
  stdoutLines(): AsyncIterable<string>;
  /** Exit code of the child (resolved when the process exits). */
  exited: Promise<number>;
  /** Kill the child process (SIGTERM on POSIX, taskkill on Windows). */
  kill(signal?: number): Promise<void>;
  /** Optional stderr line stream (debug logging). */
  stderrLines?(): AsyncIterable<string>;
}

/** Factory that produces a child process handle from an argv. */
export type SpawnFn = (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<SpawnHandle>;

/** Error thrown when a JSON-RPC request fails or times out. */
export class StdioTransportError extends Error {
  public readonly code: number | string;
  constructor(message: string, code: number | string = 'transport_error') {
    super(message);
    this.name = 'StdioTransportError';
    this.code = code;
  }
}

/** STDIO transport. */
export class StdioMcpTransport {
  private readonly config: McpServerConfig;
  private readonly requestTimeoutMs: number;
  private readonly onNotification?: NotificationHandler;
  private readonly spawn: SpawnFn;

  private handle: SpawnHandle | null = null;
  private readonly pending: Map<number, PendingRequest> = new Map();
  private nextId = 1;
  private connectedFlag = false;
  private pumpAbort: AbortController | null = null;

  constructor(options: StdioMcpTransportOptions) {
    this.config = options.config;
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.config.timeout ?? 30_000;
    if (options.onNotification !== undefined) {
      this.onNotification = options.onNotification;
    }
    this.spawn = options.spawn ?? defaultSpawn;
  }

  /** True after {@link connect} succeeded and before {@link disconnect}. */
  isConnected(): boolean {
    return this.connectedFlag;
  }

  /**
   * Spawn the subprocess and start pumping stdout. Idempotent: calling
   * twice without a `disconnect` in between is a no-op.
   */
  async connect(): Promise<void> {
    if (this.connectedFlag) return;
    const argv = this.config.command;
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new StdioTransportError(
        `MCP server "${this.config.name}" is missing the "command" array`,
        'invalid_config',
      );
    }

    const env: Record<string, string> = {};
    // Start with the current process env; explicit config wins.
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        env[k] = v;
      }
    }

    const handle = await this.spawn(argv, env);
    this.handle = handle;
    this.pumpAbort = new AbortController();
    this.connectedFlag = true;

    // Fire-and-forget pump. The pump reads stdout line-by-line and
    // dispatches responses to the matching pending request. It also
    // surfaces notifications to the onNotification callback.
    void this.pumpStdout(handle, this.pumpAbort.signal).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('stdio pump stopped', { server: this.config.name, error: message });
    });

    logger.debug('stdio transport connected', {
      server: this.config.name,
      argv: argv.join(' '),
    });
  }

  /**
   * Tear down the subprocess, reject every pending request, and reset
   * internal state. Safe to call when already disconnected.
   */
  async disconnect(): Promise<void> {
    if (!this.connectedFlag) return;
    this.connectedFlag = false;
    this.pumpAbort?.abort();
    this.pumpAbort = null;
    if (this.handle) {
      try {
        await this.handle.kill();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('kill raised on disconnect', {
          server: this.config.name,
          error: message,
        });
      }
    }
    this.handle = null;
    for (const pending of this.pending.values()) {
      pending.controller.abort();
      pending.reject(new StdioTransportError('transport disconnected'));
    }
    this.pending.clear();
  }

  /** Send a JSON-RPC request and await the matching response. */
  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.connectedFlag || this.handle === null) {
      throw new StdioTransportError('transport is not connected');
    }
    const id = this.nextId++;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.reject(
          new StdioTransportError(
            `request "${method}" timed out after ${String(this.requestTimeoutMs)} ms`,
            'request_timeout',
          ),
        );
      }
    }, Math.max(1, this.requestTimeoutMs));

    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, {
        id,
        resolve,
        reject,
        controller,
      });
    });

    const envelope: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    try {
      await this.handle.writeLine(JSON.stringify(envelope));
    } catch (err) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw new StdioTransportError(
        err instanceof Error ? `write failed: ${err.message}` : String(err),
        'write_error',
      );
    }

    try {
      const result = await promise;
      clearTimeout(timer);
      return result as T;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof StdioTransportError) throw err;
      throw new StdioTransportError(
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /** Send a JSON-RPC notification (no `id` — fire and forget). */
  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (!this.connectedFlag || this.handle === null) {
      throw new StdioTransportError('transport is not connected');
    }
    const envelope: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    };
    await this.handle.writeLine(JSON.stringify(envelope));
  }

  // -- Internals ---------------------------------------------------------

  /** Read stdout lines forever, dispatching responses and notifications. */
  private async pumpStdout(handle: SpawnHandle, signal: AbortSignal): Promise<void> {
    let buffer = '';
    for await (const rawLine of handle.stdoutLines()) {
      if (signal.aborted) return;
      const line = rawLine.trim();
      if (line.length === 0) continue;
      // Many MCP servers log diagnostic JSON to stderr; we just discard
      // anything that fails to parse as JSON-RPC.
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        buffer = '';
        continue;
      }
      void buffer;
      this.dispatchFrame(parsed);
    }
  }

  private dispatchFrame(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    const obj = frame as Record<string, unknown>;
    const id = obj['id'];
    const method = obj['method'];
    const hasId = id !== undefined && id !== null;
    const hasMethod = typeof method === 'string';

    if (hasId) {
      const pending = this.pending.get(Number(id));
      const error = obj['error'];
      if (error !== undefined && error !== null && typeof error === 'object') {
        if (pending) {
          this.pending.delete(Number(id));
          const errObj = error as JsonRpcError;
          pending.reject(
            new StdioTransportError(
              typeof errObj.message === 'string' ? errObj.message : 'JSON-RPC error',
              typeof errObj.code === 'number' ? errObj.code : 'jsonrpc_error',
            ),
          );
        }
        return;
      }
      const result = obj['result'];
      if (pending) {
        this.pending.delete(Number(id));
        pending.resolve(result);
      }
      return;
    }

    if (hasMethod) {
      // Notification: route to the handler. Errors are swallowed because
      // notifications are best-effort.
      try {
        this.onNotification?.(method as string, obj['params']);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('notification handler threw', {
          server: this.config.name,
          method,
          error: message,
        });
      }
    }
  }
}

// -- Default spawn implementation -----------------------------------------

/** Default {@link SpawnFn} backed by `Bun.spawn`. */
export const defaultSpawn: SpawnFn = async (argv, env) => {
  const proc = Bun.spawn({
    cmd: [...argv],
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  const writeLine = async (line: string): Promise<void> => {
    const stdin = proc.stdin;
    if (!stdin) throw new Error('child stdin is not a writable stream');
    const writer = stdin as unknown as WritableStreamDefaultWriter<Uint8Array>;
    if (typeof (writer as { write?: unknown }).write === 'function') {
      await writer.write(encoder.encode(`${line}\n`));
    } else {
      // Fallback: the stream-like `stdin` is actually a `FileSink`; the
      // write() method accepts Uint8Array synchronously and returns a
      // number of bytes written.
      (stdin as unknown as { write(data: Uint8Array): number }).write(
        encoder.encode(`${line}\n`),
      );
    }
  };

  const stdoutLines = async function* (): AsyncGenerator<string> {
    const stream = proc.stdout;
    if (!stream) return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.length > 0) yield buffer;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const raw = buffer.slice(0, newlineAt).replace(/\r$/, '');
          buffer = buffer.slice(newlineAt + 1);
          yield raw;
          newlineAt = buffer.indexOf('\n');
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  };

  const stderrLines = async function* (): AsyncGenerator<string> {
    const stream = proc.stderr;
    if (!stream) return;
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (buffer.length > 0) yield buffer;
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        let newlineAt = buffer.indexOf('\n');
        while (newlineAt !== -1) {
          const raw = buffer.slice(0, newlineAt).replace(/\r$/, '');
          buffer = buffer.slice(newlineAt + 1);
          yield raw;
          newlineAt = buffer.indexOf('\n');
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
  };

  return {
    writeLine,
    stdoutLines,
    stderrLines,
    exited: proc.exited,
    async kill(signal?: number): Promise<void> {
      try {
        proc.kill(signal ?? (process.platform === 'win32' ? 9 : 15));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('kill raised', { error: message });
      }
      // Give the process a moment to exit, then reap.
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
    },
  };
};

/** Factory that creates a STDIO transport for a given config. */
export function createStdioMcpTransport(options: StdioMcpTransportOptions): StdioMcpTransport {
  return new StdioMcpTransport(options);
}

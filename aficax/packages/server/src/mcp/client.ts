// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\mcp\client.ts
// McpClient: the high-level wrapper that ties a transport to the MCP
// lifecycle (connect → initialize → list tools → call tool → disconnect).
//
// Responsibilities:
//   * Hold a single transport (STDIO or HTTP) for one configured server.
//   * Drive the JSON-RPC `initialize` handshake and surface the server's
//     advertised capabilities.
//   * Cache the result of `tools/list` and expose `listTools()` /
//     `callTool()` to the rest of the system.
//   * Reconnect with exponential backoff when the transport dies (3
//     attempts by default).
//   * Enforce a per-call timeout (30 s by default).
//
// The class is intentionally a single server: the {@link McpManager} keeps
// one instance per configured server.

import { getLogger, type McpServerConfig, type McpToolDefinition, type McpToolResult } from '@aficax/core';

import {
  createHttpMcpTransport,
  HttpMcpTransport,
  type HttpMcpTransportOptions,
} from './transport/http.js';
import {
  createStdioMcpTransport,
  StdioMcpTransport,
  StdioTransportError,
  type StdioMcpTransportOptions,
} from './transport/stdio.js';

const logger = getLogger();

/** MCP method names used by this client. Centralised for grep-ability. */
const METHODS = {
  initialize: 'initialize',
  ping: 'ping',
  listTools: 'tools/list',
  callTool: 'tools/call',
} as const;

/** Shape of the `initialize` request. */
interface InitializeParams {
  readonly protocolVersion: string;
  readonly capabilities: {
    readonly sampling?: Record<string, never>;
    readonly roots?: { readonly listChanged?: boolean };
  };
  readonly clientInfo: { readonly name: string; readonly version: string };
}

/** Server capabilities we care about (others are accepted but ignored). */
export interface McpServerCapabilities {
  readonly tools?: { readonly listChanged?: boolean };
  readonly resources?: { readonly subscribe?: boolean; readonly listChanged?: boolean };
  readonly prompts?: { readonly listChanged?: boolean };
  readonly logging?: Record<string, never>;
}

/** Result of the `initialize` handshake. */
export interface InitializeResult {
  readonly protocolVersion: string;
  readonly capabilities: McpServerCapabilities;
  readonly serverInfo: { readonly name: string; readonly version: string };
  /** Optional instructions printed to the user on connect. */
  readonly instructions?: string;
}

/** Public configuration of {@link McpClient}. */
export interface McpClientOptions {
  readonly config: McpServerConfig;
  /**
   * Maximum number of reconnect attempts when the transport dies. Defaults
   * to 3. Each attempt waits `min(baseDelay * 2^attempt, maxDelay)`.
   */
  readonly maxReconnectAttempts?: number;
  /** Base delay for the exponential backoff (ms). */
  readonly baseReconnectDelayMs?: number;
  /** Upper bound on the backoff sleep (ms). */
  readonly maxReconnectDelayMs?: number;
  /** Per-request timeout in ms. Defaults to the config's `timeout` or 30 s. */
  readonly requestTimeoutMs?: number;
  /** Override the transport factories (tests). */
  readonly stdioFactory?: (options: StdioMcpTransportOptions) => StdioMcpTransport;
  readonly httpFactory?: (options: HttpMcpTransportOptions) => HttpMcpTransport;
  /** Client identity sent in the `initialize` handshake. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY = 500;
const DEFAULT_MAX_DELAY = 4_000;
const PROTOCOL_VERSION = '2025-06-18';

/** Thrown by {@link McpClient} when an MCP operation fails irrecoverably. */
export class McpClientError extends Error {
  public readonly code: number | string;
  public readonly serverName: string;
  constructor(serverName: string, message: string, code: number | string = 'mcp_error') {
    super(message);
    this.name = 'McpClientError';
    this.serverName = serverName;
    this.code = code;
  }
}

/** Single-server MCP client. */
export class McpClient {
  private readonly config: McpServerConfig;
  private readonly maxReconnectAttempts: number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly stdioFactory: (options: StdioMcpTransportOptions) => StdioMcpTransport;
  private readonly httpFactory: (options: HttpMcpTransportOptions) => HttpMcpTransport;
  private readonly clientInfo: { readonly name: string; readonly version: string };

  private transport: StdioMcpTransport | HttpMcpTransport | null = null;
  private initializeResult: InitializeResult | null = null;
  private toolCache: McpToolDefinition[] | null = null;
  /** Set when the transport dies; the next call triggers a reconnect. */
  private transportDirty = false;

  constructor(options: McpClientOptions) {
    this.config = options.config;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseReconnectDelayMs = options.baseReconnectDelayMs ?? DEFAULT_BASE_DELAY;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? DEFAULT_MAX_DELAY;
    this.requestTimeoutMs = options.requestTimeoutMs ?? options.config.timeout ?? 30_000;
    this.stdioFactory = options.stdioFactory ?? ((o) => createStdioMcpTransport(o));
    this.httpFactory = options.httpFactory ?? ((o) => createHttpMcpTransport(o));
    this.clientInfo = options.clientInfo ?? { name: 'aficax', version: '0.1.0' };
  }

  /** Name of the configured server. */
  get serverName(): string {
    return this.config.name;
  }

  /** Last initialize result, if a connection has succeeded at least once. */
  get lastInitializeResult(): InitializeResult | null {
    return this.initializeResult;
  }

  /** True iff the underlying transport is currently connected. */
  isConnected(): boolean {
    return this.transport !== null && this.transport.isConnected() && !this.transportDirty;
  }

  /**
   * Connect to the server, run the `initialize` handshake, and cache the
   * advertised capabilities. Subsequent calls are no-ops while connected.
   */
  async connect(): Promise<void> {
    if (this.isConnected()) return;
    if (this.config.type === 'stdio') {
      this.transport = this.stdioFactory({
        config: this.config,
        requestTimeoutMs: this.requestTimeoutMs,
        onNotification: (method, params) => this.handleNotification(method, params),
      });
    } else {
      this.transport = this.httpFactory({
        config: this.config,
        requestTimeoutMs: this.requestTimeoutMs,
        onNotification: (method, params) => this.handleNotification(method, params),
      });
    }
    try {
      await this.transport.connect();
    } catch (err) {
      this.transport = null;
      throw new McpClientError(
        this.config.name,
        err instanceof Error ? err.message : String(err),
        'connect_failed',
      );
    }
    this.transportDirty = false;
    await this.initialize();
    logger.debug('mcp client connected', {
      server: this.config.name,
      protocol: this.initializeResult?.protocolVersion,
    });
  }

  /**
   * Tear down the transport. Safe to call when already disconnected.
   */
  async disconnect(): Promise<void> {
    if (this.transport === null) return;
    try {
      await this.transport.disconnect();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('disconnect raised', { server: this.config.name, error: message });
    } finally {
      this.transport = null;
      this.initializeResult = null;
      this.toolCache = null;
    }
  }

  /**
   * Return the list of tools the server advertises. Re-fetches on every
   * call after a `notifications/tools/list_changed` notification; otherwise
   * the cached result is returned.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    await this.ensureConnected();
    if (this.toolCache !== null) return this.toolCache;
    const result = await this.request<{ tools: McpToolDefinition[] }>(METHODS.listTools, {});
    this.toolCache = result.tools ?? [];
    return this.toolCache;
  }

  /**
   * Invoke a tool by name. The result is returned as-is; the caller is
   * responsible for converting the MCP content blocks into Aficax's
   * `ToolResult` shape (see `discovery.ts`).
   */
  async callTool(name: string, input: unknown): Promise<McpToolResult> {
    if (typeof name !== 'string' || name.length === 0) {
      throw new McpClientError(this.config.name, 'tool name is required', 'invalid_input');
    }
    await this.ensureConnected();
    return this.request<McpToolResult>(METHODS.callTool, {
      name,
      ...(input !== undefined ? { arguments: input } : {}),
    });
  }

  /**
   * Force a reconnection. Used by the `/mcp/servers/:name/reconnect`
   * route and by the manager's recovery path. Returns when the new
   * connection is ready.
   */
  async reconnect(): Promise<void> {
    await this.disconnect();
    await this.connect();
  }

  // -- Internals ---------------------------------------------------------

  /** Run the `initialize` handshake. */
  private async initialize(): Promise<void> {
    const params: InitializeParams = {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    };
    const result = await this.request<InitializeResult>(METHODS.initialize, params);
    this.initializeResult = result;
  }

  /**
   * Issue a JSON-RPC request, with automatic reconnect-once-then-retry
   * semantics. If the transport errors out, we tear it down, reconnect,
   * and try the request again exactly once.
   */
  private async request<T>(method: string, params: unknown): Promise<T> {
    if (this.transport === null) {
      throw new McpClientError(this.config.name, 'not connected', 'not_connected');
    }
    try {
      return (await this.transport.sendRequest<T>(method, params));
    } catch (err) {
      // `request_timeout` is a "could be transient" error — try one
      // reconnect before bubbling up. Other errors are passed through.
      if (err instanceof StdioTransportError && err.code === 'request_timeout') {
        await this.attemptReconnect();
        if (this.transport === null) {
          throw new McpClientError(this.config.name, 'lost transport after timeout', 'lost_transport');
        }
        return this.transport.sendRequest<T>(method, params);
      }
      if (err instanceof Error && /aborted|closed|disconnected/i.test(err.message)) {
        this.transportDirty = true;
        await this.attemptReconnect();
        if (this.transport === null) {
          throw new McpClientError(this.config.name, 'lost transport', 'lost_transport');
        }
        return this.transport.sendRequest<T>(method, params);
      }
      throw new McpClientError(
        this.config.name,
        err instanceof Error ? err.message : String(err),
        err instanceof StdioTransportError ? err.code : 'mcp_error',
      );
    }
  }

  /** Reconnect with bounded exponential backoff. No-op if already healthy. */
  private async attemptReconnect(): Promise<void> {
    if (this.transport !== null && this.transport.isConnected() && !this.transportDirty) {
      return;
    }
    for (let attempt = 1; attempt <= this.maxReconnectAttempts; attempt++) {
      const delay = Math.min(
        this.maxReconnectDelayMs,
        this.baseReconnectDelayMs * 2 ** (attempt - 1),
      );
      logger.info('mcp reconnect: waiting', {
        server: this.config.name,
        attempt,
        delay,
      });
      await sleep(delay);
      try {
        await this.disconnect();
        await this.connect();
        this.transportDirty = false;
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('mcp reconnect attempt failed', {
          server: this.config.name,
          attempt,
          error: message,
        });
      }
    }
    logger.error('mcp reconnect: giving up', { server: this.config.name });
    this.transport = null;
  }

  /** Ensure the transport is healthy; reconnect lazily if needed. */
  private async ensureConnected(): Promise<void> {
    if (this.transport === null) {
      await this.connect();
      return;
    }
    if (this.transportDirty || !this.transport.isConnected()) {
      await this.attemptReconnect();
    }
  }

  /** Handle server-initiated notifications. */
  private handleNotification(method: string, _params: unknown): void {
    // The only notification we currently act on is `notifications/tools/list_changed`,
    // which forces a re-fetch on the next `listTools` call.
    if (method === 'notifications/tools/list_changed') {
      this.toolCache = null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** Factory that creates an {@link McpClient} bound to a config. */
export function createMcpClient(options: McpClientOptions): McpClient {
  return new McpClient(options);
}

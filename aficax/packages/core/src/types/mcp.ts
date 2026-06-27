// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\mcp.ts
// Model Context Protocol: server configurations, status, and tool bridging.

import type { ToolDefinition } from './tool.js';

/** Transport used to talk to a MCP server. */
export type MCPServerType = 'stdio' | 'http' | 'websocket';

/** Static configuration of a single MCP server. */
export interface MCPServerConfig {
  readonly name: string;
  readonly type: MCPServerType;
  /** For `stdio`: the executable to spawn. */
  readonly command?: string;
  /** For `stdio`: arguments passed to the executable. */
  readonly args: readonly string[];
  /** For `http` / `websocket`: the server URL. */
  readonly url?: string;
  /** Environment variables set on the spawned stdio process. */
  readonly env: Record<string, string>;
  readonly auth: MCPAuth;
}

/** Authentication strategy used to connect to a MCP server. */
export type MCPAuth =
  | { readonly kind: 'none' }
  | { readonly kind: 'env'; readonly envVar: string }
  | {
      readonly kind: 'oauth';
      readonly clientId: string;
      readonly clientSecret?: string;
      readonly tokenUrl: string;
      readonly scopes?: readonly string[];
    };

/** Runtime status of a registered MCP server. */
export interface MCPServerStatus {
  readonly name: string;
  readonly connected: boolean;
  readonly error?: string;
  readonly tools: readonly string[];
}

/** A tool exposed by a MCP server, in Aficax's internal tool shape. */
export interface MCPToolInfo {
  readonly serverName: string;
  readonly tool: ToolDefinition;
}

// -------------------------------------------------------------------------
// Phase 8 — simplified MCP configuration + native tool definitions.
// -------------------------------------------------------------------------

/** Per-server transport discriminator. */
export type McpServerTransport = 'stdio' | 'http';

/**
 * Phase-8 MCP server configuration. Distinct from the older
 * {@link MCPServerConfig} which splits `command` + `args`; this shape uses a
 * single `command: string[]` array (argv) and drops the explicit auth
 * field, leaving authentication to the underlying transport (env vars,
 * `Authorization` headers, etc.).
 */
export interface McpServerConfig {
  /** Stable name used to namespace the server's tools. */
  readonly name: string;
  /** Transport the client should use to talk to the server. */
  readonly type: McpServerTransport;
  /** For `stdio`: the argv to spawn. Element 0 is the executable. */
  readonly command?: readonly string[];
  /** For `http`: the server endpoint URL. */
  readonly url?: string;
  /** Optional environment variables (merged on top of `process.env`). */
  readonly env?: Readonly<Record<string, string>>;
  /** Per-call timeout in milliseconds. Defaults to 30 s when omitted. */
  readonly timeout?: number;
}

/**
 * Tool definition in the native MCP protocol shape. Mirrors the JSON
 * payload a server returns for `tools/list`. Aficax's discovery layer
 * converts this into the project's internal {@link ToolDefinition} shape.
 */
export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  /** JSON Schema describing the tool's input. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties?: boolean | Readonly<Record<string, unknown>>;
    readonly [key: string]: unknown;
  };
  /** Optional server-provided hints (added in MCP 2025-06-18). */
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
    readonly [key: string]: unknown;
  };
}

/** A single content item returned by a `tools/call` response. */
export type McpToolContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly data: string;
      readonly mimeType: string;
    }
  | {
      readonly type: 'resource';
      readonly uri: string;
      readonly mimeType?: string;
      readonly text?: string;
      readonly blob?: string;
    };

/** Result payload of a successful `tools/call`. */
export interface McpToolResult {
  readonly content: readonly McpToolContent[];
  readonly isError?: boolean;
}

// Re-export helpers from the older section (kept for backwards compat).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _legacyBridge: MCPServerConfig = {
  name: 'unused',
  type: 'stdio',
  args: [],
  env: {},
  auth: { kind: 'none' },
};
void _legacyBridge;

/** Helper: produce a `none` auth value without spelling out the object. */
export function noAuth(): MCPAuth {
  return { kind: 'none' };
}

/** Helper: produce an `env`-based auth value. */
export function envAuth(envVar: string): MCPAuth {
  return { kind: 'env', envVar };
}

/** Helper: produce an `oauth` auth value. */
export function oauthAuth(
  clientId: string,
  tokenUrl: string,
  options: { readonly clientSecret?: string; readonly scopes?: readonly string[] } = {},
): MCPAuth {
  const base: { kind: 'oauth'; clientId: string; tokenUrl: string; clientSecret?: string; scopes?: readonly string[] } = {
    kind: 'oauth',
    clientId,
    tokenUrl,
  };
  let result: MCPAuth = base;
  if (options.clientSecret !== undefined) {
    result = { ...result, clientSecret: options.clientSecret };
  }
  if (options.scopes !== undefined) {
    result = { ...result, scopes: options.scopes };
  }
  return result;
}

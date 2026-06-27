// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\mcp\discovery.ts
// Discovery: convert native MCP tool definitions into Aficax's internal
// `ToolDefinition` shape, decide on a `PermissionLevel`, and namespace
// the tool name with the server prefix.
//
// The namespace convention is `mcp__<serverName>__<toolName>`. It is
// the responsibility of the {@link McpManager} to register the resulting
// tool with this exact name in the shared `ToolRegistry` and to build a
// `ToolImplementation` whose `execute` forwards the call to
// {@link McpClient.callTool}.

import {
  type McpToolDefinition,
  type McpToolResult,
  type PermissionLevel,
  type ToolDefinition,
  type ToolResult,
} from '@aficax/core';

import type { McpClient } from './client.js';

/** Configuration for the conversion. */
export interface DiscoveryOptions {
  /** Name of the MCP server the tools belong to. */
  readonly serverName: string;
  /**
   * When `true` the converter picks `auto_approve` for read-only tools
   * (those whose MCP `readOnlyHint` is `true`). Defaults to `false`, i.e.
   * every MCP tool is `require_approval` by default — this is the safe
   * behaviour for arbitrary external code.
   */
  readonly trustReadOnlyAnnotations?: boolean;
}

/** Convert a single MCP tool into an Aficax {@link ToolDefinition}. */
export function convertTool(
  mcp: McpToolDefinition,
  options: DiscoveryOptions,
): ToolDefinition {
  const namespacedName = namespaceToolName(options.serverName, mcp.name);
  const description = (mcp.description ?? '').trim();

  return {
    name: namespacedName,
    description:
      description.length > 0
        ? `[${options.serverName}] ${description}`
        : `[${options.serverName}] (no description provided by the MCP server)`,
    inputSchema: normaliseInputSchema(mcp.inputSchema),
    permissionLevel: pickPermissionLevel(mcp, options),
  };
}

/** Convert the full list of tools advertised by a client. */
export async function discoverTools(
  client: McpClient,
  options: DiscoveryOptions,
): Promise<ToolDefinition[]> {
  const advertised = await client.listTools();
  return advertised.map((tool) => convertTool(tool, options));
}

/** Build the namespaced tool name used in the ToolRegistry. */
export function namespaceToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/** Extract the server name from a namespaced tool name (reverse of {@link namespaceToolName}). */
export function unnamespaceToolName(
  namespaced: string,
): { serverName: string; toolName: string } | null {
  const match = /^mcp__([a-zA-Z0-9_\-.]+)__(.+)$/.exec(namespaced);
  if (match === null) return null;
  const [, serverName, toolName] = match;
  if (serverName === undefined || toolName === undefined) return null;
  return { serverName, toolName };
}

/** Convert a list of MCP tool names to namespaced names. */
export function namespaceToolNames(
  serverName: string,
  toolNames: readonly string[],
): readonly string[] {
  return toolNames.map((name) => namespaceToolName(serverName, name));
}

/**
 * Convert a single MCP {@link McpToolResult} into Aficax's
 * {@link ToolResult} shape. The function concatenates every text content
 * block; non-text content blocks are summarised so the model can see what
 * was returned.
 */
export function convertToolResult(result: McpToolResult): ToolResult {
  const lines: string[] = [];
  let isError = result.isError === true;

  for (const item of result.content) {
    switch (item.type) {
      case 'text': {
        lines.push(item.text);
        if (looksLikeError(item.text)) isError = true;
        break;
      }
      case 'image': {
        lines.push(`[image: ${item.mimeType}, ${String(item.data.length)} base64 chars]`);
        break;
      }
      case 'resource': {
        lines.push(`[resource: ${item.uri}${item.mimeType ? ` (${item.mimeType})` : ''}]`);
        if (typeof item.text === 'string') {
          lines.push(item.text);
        }
        break;
      }
    }
  }

  const content = lines.join('\n').trim();
  return {
    content: content.length === 0 ? '(empty result)' : content,
    isError,
    metadata: {
      mcp: true,
      blocks: result.content.length,
    },
  };
}

// -- Helpers --------------------------------------------------------------

/**
 * Pick a {@link PermissionLevel} for the tool. The decision is:
 *   - `always_deny` never (we don't assume an MCP server is hostile).
 *   - `auto_approve` only when the server explicitly marks the tool as
 *      read-only AND the caller trusts annotations.
 *   - `require_approval` for everything else.
 */
function pickPermissionLevel(
  mcp: McpToolDefinition,
  options: DiscoveryOptions,
): PermissionLevel {
  const annotations = mcp.annotations;
  const isReadOnly = annotations?.readOnlyHint === true;
  const isDestructive = annotations?.destructiveHint === true;
  if (isDestructive) {
    // Destructive tools always require explicit user approval.
    return 'require_approval';
  }
  if (isReadOnly && options.trustReadOnlyAnnotations === true) {
    return 'auto_approve';
  }
  return 'require_approval';
}

/**
 * Coerce the MCP inputSchema into the project's `JsonSchema` shape. The
 * MCP `additionalProperties` field is `boolean | object`; we narrow it to
 * what the core types expect.
 */
function normaliseInputSchema(
  schema: McpToolDefinition['inputSchema'],
): ToolDefinition['inputSchema'] {
  const out: {
    type?: 'object';
    properties?: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean | Record<string, unknown>;
    description?: string;
    [key: string]: unknown;
  } = {
    type: 'object',
  };
  if (schema.properties !== undefined) {
    out.properties = { ...schema.properties };
  }
  if (schema.required !== undefined) {
    out.required = [...schema.required];
  }
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  return out as ToolDefinition['inputSchema'];
}

/**
 * Heuristic: detect whether a tool returned an error payload that the
 * caller probably wants surfaced. We treat strings starting with common
 * error prefixes (case-insensitive) as an error.
 */
function looksLikeError(text: string): boolean {
  const head = text.slice(0, 64).toLowerCase();
  if (head.length === 0) return false;
  return (
    head.startsWith('error:') ||
    head.startsWith('error -') ||
    head.startsWith('failed:') ||
    head.startsWith('fatal:') ||
    head.startsWith('exception:')
  );
}

/** Convenience export for tests: build a JSON-RPC `tools/call` payload. */
export function buildCallToolParams(
  namespaced: string,
  input: unknown,
): { name: string; arguments: unknown } {
  const unnamespaced = unnamespaceToolName(namespaced);
  if (unnamespaced === null) {
    throw new Error(`tool name "${namespaced}" is not a namespaced MCP tool`);
  }
  return { name: unnamespaced.toolName, arguments: input };
}

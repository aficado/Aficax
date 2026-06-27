// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\mcp\manager.ts
// McpManager: lifecycle owner for every MCP server the agent talks to.
//
// Responsibilities:
//   * Load the server list from `<cwd>/.aficax/mcp.json` and
//     `~/.aficax/mcp.json` (project wins, global fills in).
//   * Build a {@link McpClient} per server, connect on init, disconnect
//     on shutdown.
//   * Convert each server's advertised tools into Aficax's internal
//     `ToolDefinition` shape and register a `ToolImplementation` in the
//     shared `ToolRegistry` under the namespaced name
//     `mcp__<serverName>__<toolName>`.
//   * Re-run discovery on demand via {@link McpManager.refreshTools} so
//     the model always sees an up-to-date tool list.
//   * Expose per-server status (connected / error / tool list) for the
//     TUI's status bar.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import {
  getLogger,
  globalConfigDir,
  projectConfigDir,
  type MCPServerStatus,
  type McpServerConfig,
  type ToolDefinition,
  type ToolInput,
  type ToolResult,
} from '@aficax/core';

import { McpClient, McpClientError, type McpClientOptions } from './client.js';
import {
  convertToolResult,
  discoverTools,
  namespaceToolName,
  unnamespaceToolName,
} from './discovery.js';
import { type ToolImplementation, type ToolRegistry } from '../tools/registry.js';

const logger = getLogger();

/** Status of a single MCP server as the manager sees it. */
export interface ManagedServer {
  readonly name: string;
  readonly type: 'stdio' | 'http';
  readonly connected: boolean;
  readonly error?: string;
  readonly toolNames: readonly string[];
}

/** On-disk shape of a `mcp.json` file. */
interface McpFile {
  readonly version?: number;
  readonly servers?: readonly McpServerConfig[];
}

/** Public configuration of the manager. */
export interface McpManagerOptions {
  /**
   * Working directory used to locate the project-level `mcp.json`. The
   * manager also looks at `~/.aficax/mcp.json` for the global file.
   */
  readonly workingDir: string;
  /** Pre-built tool registry; the manager registers tools into it. */
  readonly tools: ToolRegistry;
  /**
   * When `true`, tools marked `readOnlyHint` in the MCP schema are
   * registered as `auto_approve`. Defaults to `false` (every MCP tool
   * requires user approval).
   */
  readonly trustReadOnlyAnnotations?: boolean;
  /** Override the clock (tests). */
  readonly now?: () => number;
  /** Override the mcp.json readers (tests). */
  readonly globalConfigReader?: () => Promise<McpFile>;
  readonly projectConfigReader?: () => Promise<McpFile>;
  /** Override client construction (tests). */
  readonly clientFactory?: (options: McpClientOptions) => McpClient;
}

/** Path to the global MCP config file. */
function globalMcpJsonPath(): string {
  return `${globalConfigDir()}/mcp.json`;
}

/** Path to the project-level MCP config file. */
function projectMcpJsonPath(cwd: string): string {
  return `${projectConfigDir(cwd)}/mcp.json`;
}

/**
 * Default mcp.json reader. Tries the file, returns an empty config when
 * missing or malformed.
 */
async function readMcpFile(path: string): Promise<McpFile> {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('mcp.json could not be read', { path, error: message });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('mcp.json is not valid JSON', { path, error: message });
    return {};
  }
  return normaliseMcpFile(parsed);
}

function normaliseMcpFile(value: unknown): McpFile {
  if (typeof value !== 'object' || value === null) return {};
  const obj = value as Record<string, unknown>;
  const version = obj['version'];
  const servers = obj['servers'];
  if (!Array.isArray(servers)) return {};
  const out: McpServerConfig[] = [];
  for (const raw of servers) {
    const parsed = parseMcpServerEntry(raw);
    if (parsed !== null) out.push(parsed);
  }
  return { version: typeof version === 'number' ? version : 1, servers: out };
}

function parseMcpServerEntry(value: unknown): McpServerConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const name = obj['name'];
  const type = obj['type'];
  if (typeof name !== 'string' || name.length === 0) return null;
  if (type !== 'stdio' && type !== 'http') return null;

  const command = parseStringArray(obj['command']);
  const urlRaw = obj['url'];
  const envRaw = obj['env'];
  const timeoutRaw = obj['timeout'];

  const config: {
    name: string;
    type: 'stdio' | 'http';
    command?: readonly string[];
    url?: string;
    env?: Record<string, string>;
    timeout?: number;
  } = { name, type };
  if (command !== null) config.command = command;
  if (typeof urlRaw === 'string' && urlRaw.length > 0) config.url = urlRaw;
  if (envRaw !== undefined) {
    const env = parseStringRecord(envRaw);
    if (env !== null) config.env = env;
  }
  if (typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw) && timeoutRaw > 0) {
    config.timeout = Math.floor(timeoutRaw);
  }
  return config;
}

function parseStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || v.length === 0) return null;
    out.push(v);
  }
  return out;
}

function parseStringRecord(value: unknown): Record<string, string> | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/** Merge two server lists, with the project list winning on name collision. */
function mergeConfigs(global: readonly McpServerConfig[], project: readonly McpServerConfig[]): McpServerConfig[] {
  const byName = new Map<string, McpServerConfig>();
  for (const cfg of project) byName.set(cfg.name, cfg);
  for (const cfg of global) {
    if (!byName.has(cfg.name)) byName.set(cfg.name, cfg);
  }
  return Array.from(byName.values());
}

/**
 * Manager for the per-process MCP server fleet. Created once at server
 * start; lives for the duration of the process.
 */
export class McpManager {
  private readonly tools: ToolRegistry;
  private readonly trustReadOnlyAnnotations: boolean;
  private readonly now: () => number;
  private readonly globalConfigReader: () => Promise<McpFile>;
  private readonly projectConfigReader: () => Promise<McpFile>;
  private readonly clientFactory: (options: McpClientOptions) => McpClient;
  private readonly clients: Map<string, ManagedClient> = new Map();

  constructor(options: McpManagerOptions) {
    this.tools = options.tools;
    this.trustReadOnlyAnnotations = options.trustReadOnlyAnnotations ?? false;
    this.now = options.now ?? Date.now;
    this.globalConfigReader = options.globalConfigReader ?? (() => readMcpFile(globalMcpJsonPath()));
    this.projectConfigReader =
      options.projectConfigReader ??
      (() => readMcpFile(projectMcpJsonPath(options.workingDir)));
    this.clientFactory = options.clientFactory ?? ((o) => new McpClient(o));
  }

  /**
   * Read every configured `mcp.json`, build a client per server, and
   * connect each one in the background. Connections that fail are
   * recorded in {@link McpManager.listServers} but do not prevent the
   * manager from starting.
   */
  async start(): Promise<void> {
    const [global, project] = await Promise.all([
      this.globalConfigReader(),
      this.projectConfigReader(),
    ]);
    const configs = mergeConfigs(global.servers ?? [], project.servers ?? []);
    await Promise.all(
      configs.map(async (config) => {
        const managed = this.makeManaged(config);
        this.clients.set(config.name, managed);
        await this.connectOne(managed);
      }),
    );
  }

  /**
   * Stop every managed client and clear the namespaced tool registrations
   * from the shared registry. Safe to call multiple times.
   */
  async stop(): Promise<void> {
    for (const managed of this.clients.values()) {
      try {
        await managed.client.disconnect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('client disconnect raised', {
          server: managed.config.name,
          error: message,
        });
      }
    }
    this.clients.clear();
    this.unregisterAllNamespacedTools();
  }

  /**
   * Re-discover the tools advertised by every connected server and
   * re-register the namespaced tools in the shared registry. Should be
   * called before each model invocation so newly added tools become
   * available without restarting the process.
   */
  async refreshTools(): Promise<void> {
    for (const managed of this.clients.values()) {
      if (!managed.client.isConnected()) continue;
      try {
        const defs = await discoverTools(managed.client, {
          serverName: managed.config.name,
          trustReadOnlyAnnotations: this.trustReadOnlyAnnotations,
        });
        this.applyDiscovered(managed, defs);
      } catch (err) {
        managed.error = err instanceof Error ? err.message : String(err);
        logger.warn('mcp refreshTools failed', {
          server: managed.config.name,
          error: managed.error,
        });
      }
    }
  }

  /**
   * Force a reconnect of a single server. Returns `false` if the server
   * is unknown to the manager.
   */
  async reconnect(name: string): Promise<boolean> {
    const managed = this.clients.get(name);
    if (!managed) return false;
    try {
      await managed.client.reconnect();
      managed.error = undefined;
      await this.refreshServer(managed);
      return true;
    } catch (err) {
      managed.error = err instanceof Error ? err.message : String(err);
      logger.warn('mcp reconnect failed', { server: name, error: managed.error });
      return false;
    }
  }

  /**
   * Snapshot of every managed server. Used by the TUI's status bar and
   * the `/mcp/servers` HTTP route.
   */
  listServers(): readonly ManagedServer[] {
    const out: ManagedServer[] = [];
    for (const managed of this.clients.values()) {
      const base: { name: string; type: 'stdio' | 'http'; connected: boolean; toolNames: readonly string[]; error?: string } = {
        name: managed.config.name,
        type: managed.config.type,
        connected: managed.client.isConnected(),
        toolNames: managed.toolNames,
      };
      if (managed.error !== undefined) base.error = managed.error;
      out.push(base);
    }
    return out;
  }

  /** Status objects shaped for the TUI (same as the legacy `MCPServerStatus`). */
  listStatusForTui(): readonly MCPServerStatus[] {
    return this.listServers().map((s) => {
      const base: { name: string; connected: boolean; tools: readonly string[]; error?: string } = {
        name: s.name,
        connected: s.connected,
        tools: s.toolNames,
      };
      if (s.error !== undefined) base.error = s.error;
      return base;
    });
  }

  // -- Internals ---------------------------------------------------------

  /** Build a {@link ManagedClient} (without connecting) for a config. */
  private makeManaged(config: McpServerConfig): ManagedClient {
    const client = this.clientFactory({ config });
    return {
      config,
      client,
      toolNames: [],
      error: undefined,
    };
  }

  /** Connect one managed client, updating its error state on failure. */
  private async connectOne(managed: ManagedClient): Promise<void> {
    try {
      await managed.client.connect();
      managed.error = undefined;
      await this.refreshServer(managed);
    } catch (err) {
      managed.error = err instanceof Error ? err.message : String(err);
      logger.warn('mcp client connect failed', {
        server: managed.config.name,
        error: managed.error,
      });
    }
  }

  /**
   * Re-discover the tools of a single server and apply the registration
   * diff to the shared registry.
   */
  private async refreshServer(managed: ManagedClient): Promise<void> {
    try {
      const defs = await discoverTools(managed.client, {
        serverName: managed.config.name,
        trustReadOnlyAnnotations: this.trustReadOnlyAnnotations,
      });
      this.applyDiscovered(managed, defs);
    } catch (err) {
      managed.error = err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Diff the previous tool names with the new list, registering
   * implementations for new tools and stubbing out stale ones.
   */
  private applyDiscovered(
    managed: ManagedClient,
    defs: readonly ToolDefinition[],
  ): void {
    const previousNames = new Set(managed.toolNames);
    const newNames = new Set(defs.map((d) => d.name));
    // Stub out tools that disappeared.
    for (const oldName of previousNames) {
      if (!newNames.has(oldName)) {
        this.unregisterNamespacedTool(managed.config.name, oldName);
      }
    }
    // Register only the new tools. The shared registry throws on
    // duplicate names, so re-registering an already-known tool would
    // blow up; the `if (!this.tools.has(...))` guard avoids that.
    for (const def of defs) {
      if (!this.tools.has(def.name)) {
        this.registerNamespacedTool(managed, def);
      }
    }
    managed.toolNames = Array.from(newNames);
  }

  /**
   * Register a single namespaced tool in the shared registry. The
   * implementation forwards the call to the underlying MCP client and
   * converts the result via {@link convertToolResult}.
   */
  private registerNamespacedTool(
    managed: ManagedClient,
    def: ToolDefinition,
  ): void {
    const client = managed.client;
    const serverName = managed.config.name;
    const namespaced = def.name;
    // The `execute` callback runs detached from `this`; capture the clock
    // once so the metadata `ts` field uses the same source as the rest of
    // the manager (and respects the `now` override used in tests).
    const now = this.now;
    const impl: ToolImplementation = {
      definition: def,
      async execute(
        input: ToolInput,
        context: { readonly sessionId: string; readonly workingDir: string },
      ): Promise<ToolResult> {
        const start = Date.now();
        try {
          // `namespaced` is the *server-namespaced* name; the MCP client
          // expects the un-namespaced name. We strip the prefix here.
          const stripped = unnamespaceToolName(namespaced);
          if (stripped === null) {
            return {
              content: `Tool name "${namespaced}" is not a valid MCP namespace`,
              isError: true,
            };
          }
          const mcpResult = await client.callTool(stripped.toolName, input);
          const result = convertToolResult(mcpResult);
          return {
            content: result.content,
            isError: result.isError,
            metadata: {
              ...(result.metadata ?? {}),
              serverName,
              mcpTool: stripped.toolName,
              durationMs: Date.now() - start,
              sessionId: context.sessionId,
              ts: now(),
            },
          };
        } catch (err) {
          const message =
            err instanceof McpClientError
              ? `${err.message} (code: ${String(err.code)})`
              : err instanceof Error
                ? err.message
                : String(err);
          return {
            content: `MCP tool "${namespaced}" failed: ${message}`,
            isError: true,
            metadata: {
              serverName,
              mcpTool: namespaced,
              durationMs: Date.now() - start,
              crashed: true,
            },
          };
        }
      },
    };
    // The registry keys on the tool's `definition.name`; we register with
    // the namespaced name so the model sees the same identifier the
    // discovery layer produced.
    this.tools.register(impl);
  }

  /**
   * Replace a single namespaced tool with an "unregistered" stub. The
   * shared registry does not expose a real `unregister`, so we re-register
   * the slot with a stub that always returns an error. No-op when the
   * slot is not currently registered (which can happen after a partial
   * prior refresh).
   */
  private unregisterNamespacedTool(serverName: string, namespaced: string): void {
    const fullName = namespaced.startsWith('mcp__')
      ? namespaced
      : namespaceToolName(serverName, namespaced);
    if (!this.tools.has(fullName)) return;
    try {
      this.tools.register({
        definition: {
          name: fullName,
          description: `[${serverName}] (unregistered MCP tool)`,
          inputSchema: { type: 'object' },
          permissionLevel: 'always_deny',
        },
        async execute(): Promise<ToolResult> {
          return {
            content: `MCP tool "${fullName}" is no longer available`,
            isError: true,
          };
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('unregister stub failed', { name: fullName, error: message });
    }
  }

  /** Replace every namespaced tool with the "unregistered" stub. */
  private unregisterAllNamespacedTools(): void {
    for (const managed of this.clients.values()) {
      for (const name of managed.toolNames) {
        this.unregisterNamespacedTool(managed.config.name, name);
      }
      managed.toolNames = [];
    }
  }
}

interface ManagedClient {
  readonly config: McpServerConfig;
  readonly client: McpClient;
  toolNames: string[];
  /**
   * Latest error message from `connect` / `reconnect` / `refreshTools`.
   * Declared as `string | undefined` (not `?:`) so that
   * `exactOptionalPropertyTypes` accepts an explicit `undefined` when we
   * want to clear the error after a successful operation.
   */
  error: string | undefined;
}

/** Factory that creates an {@link McpManager} bound to a registry. */
export function createMcpManager(options: McpManagerOptions): McpManager {
  return new McpManager(options);
}

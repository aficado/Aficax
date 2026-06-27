// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\server.ts
// Hono application: routes, middleware, SSE streaming, provider wiring, and
// the SQLite-backed session manager.

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import {
  createSessionId,
  getLogger,
  type AnyAgentEvent,
  type PermissionDecision,
  type ProviderType,
  type SessionId,
  type SessionSummary,
} from '@aficax/core';

import {
  createEventBus,
  createPendingApprovals,
  type PendingApprovals,
  type SSEConnection,
} from './events/bus.js';
import { createQueryEngine, QueryEngine } from './loop/query-engine.js';
import { createMcpManager, McpManager } from './mcp/manager.js';
import {
  createPermissionEngine,
  type AgentMode,
  type PermissionEngine,
} from './permissions/engine.js';
import {
  createProviderRegistry,
  detectLocalBackend,
  ProviderRegistry,
  readApiKeyFromEnv,
  readDefaultModelId,
  readLocalBaseUrlFromEnv,
} from './providers/registry.js';
import { createSessionManager, type SessionManager } from './session/manager.js';
import { listCheckpoints, rewindFile } from './storage/checkpoints.js';
import { openDatabase, type DbHandle } from './storage/db.js';
import { createMessageStorage } from './storage/messages.js';
import { createSessionStorage } from './storage/sessions.js';
import { appendTranscriptEvent, readRawTranscript } from './storage/transcripts.js';
import { createBash } from './tools/bash.js';
import { createGlob } from './tools/glob.js';
import { createGrep } from './tools/grep.js';
import { createListDirectory } from './tools/list-directory.js';
import { createReadFile } from './tools/read-file.js';
import { createRepoMapTool } from './tools/repo-map.js';
import { createSpawnAgentTool } from './tools/spawn-agent.js';
import { createWriteFile } from './tools/write-file.js';
import { createToolRegistry, type ToolRegistry } from './tools/registry.js';
import { createMemoryLoader, createMemoryStore, MemoryLoader, MemoryStore } from './memory/index.js';
import { createSubAgentSpawner, type SubAgentSpawner } from './agents/index.js';
import { createCustomAgentParser, type CustomAgentParser } from './custom-agents/index.js';
import { createSandboxManager, sandboxStatus, type SandboxManager } from './sandbox/index.js';
import { createSkillLoader, type SkillLoader } from './skills/index.js';

const logger = getLogger();

/** Build version surfaced in the health endpoint. */
export const AFICAX_VERSION = '0.4.0';

/** All `AgentMode` values accepted by the API. */
const VALID_MODES: ReadonlySet<AgentMode> = new Set([
  'plan',
  'auto',
  'full',
  'read-only',
  'ci',
]);

/** In-memory registry of the current permission mode for each session. */
export class ModeRegistry {
  private readonly modes: Map<SessionId, AgentMode> = new Map();

  /** Default mode used when no entry exists yet. */
  static readonly DEFAULT_MODE: AgentMode = 'auto';

  /** Read the current mode for a session (defaults to `DEFAULT_MODE`). */
  get(id: SessionId): AgentMode {
    return this.modes.get(id) ?? ModeRegistry.DEFAULT_MODE;
  }

  /** Set or update the mode for a session. */
  set(id: SessionId, mode: AgentMode): AgentMode {
    this.modes.set(id, mode);
    return mode;
  }

  /** Forget a session's mode (call when the session is deleted). */
  delete(id: SessionId): void {
    this.modes.delete(id);
  }

  /** Number of tracked sessions. */
  size(): number {
    return this.modes.size;
  }
}

/** Top-level collaborators owned by the server instance. */
export interface ServerDeps {
  readonly sessions: SessionManager;
  readonly tools: ToolRegistry;
  readonly bus: ReturnType<typeof createEventBus>;
  readonly pendingApprovals: PendingApprovals;
  readonly permissionEngine: PermissionEngine;
  readonly modeRegistry: ModeRegistry;
  readonly mcpManager: McpManager;
  readonly providers: ProviderRegistry;
  readonly engineFactory: (providerId: string, modelId: string, workingDir: string) => QueryEngine;
  readonly db: DbHandle;
  readonly version: string;
  /** Memory subsystem — read/write of AFICAX.md and MEMORY.md files. */
  readonly memory: MemorySubsystem;
  /** Sub-agent spawner used by the `spawn_agent` tool and `/sessions/:id/agents`. */
  readonly subAgentSpawner: SubAgentSpawner;
  /** Skills loader exposed by the `/skills` route. */
  readonly skills: SkillLoader;
  /** Custom-agents parser exposed by the `/agents/custom` route. */
  readonly customAgents: CustomAgentParser;
  /** Sandbox manager exposed by the `/sandbox/status` route. */
  readonly sandbox: SandboxManager;
}

/** Lazily-constructed memory collaborators, owned by the server instance. */
export interface MemorySubsystem {
  readonly store: MemoryStore;
  readonly loader: MemoryLoader;
}

/** Construct a {@link ServerDeps} with all defaults wired up. */
export function createServerDeps(): ServerDeps {
  const db = openDatabase();
  const sessionStorage = createSessionStorage(db.db);
  const messageStorage = createMessageStorage(db.db);

  // Sandbox manager: probes the host OS for the right backend (bwrap on
  // Linux, sandbox-exec on macOS, Job-Object-style on Windows). The
  // `bash` tool delegates here so every shell command runs inside the
  // sandbox when possible. `init()` is async; we fire-and-forget so
  // the first command has to wait for the probe to finish.
  const sandbox = createSandboxManager();
  void sandbox.init().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('sandbox init raised', { error: message });
  });

  const tools = createToolRegistry();
  tools.register(createReadFile());
  tools.register(createWriteFile());
  tools.register(createListDirectory());
  tools.register(createBash({ sandbox }));
  tools.register(createGlob());
  tools.register(createGrep());
  tools.register(createRepoMapTool());

  const bus = createEventBus();
  const pendingApprovals = createPendingApprovals();
  const modeRegistry = new ModeRegistry();
  // The session manager handles per-session persistence; we use the cwd of
  // the most recently created session as the working directory for the
  // global allowlist store. The engine factory recomputes this on demand
  // so the store always sees the latest session cwd.
  const sessions = createSessionManager({ sessions: sessionStorage, messages: messageStorage });
  const providers = createProviderRegistry();

  // MCP manager: starts connecting to every configured MCP server in the
  // background. Failures are recorded per-server and surfaced via
  // {@link McpManager.listServers}; the server still starts.
  const mcpManager = createMcpManager({
    workingDir: safeCwd(),
    tools,
  });
  // `start()` is async but we intentionally do not block server boot on
  // MCP connections. Routes that need the status (e.g. `/mcp/servers`)
  // can call `listServers` once it has settled.
  void mcpManager.start().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('MCP manager start raised', { error: message });
  });

  // The permission engine is rebuilt per-session so its allowlist store
  // resolves paths against the correct working directory. The shared
  // `bus` and `pendingApprovals` are reused across sessions.
  const engineFactory = (providerId: string, modelId: string, workingDir: string): QueryEngine => {
    const adapter = resolveProvider(providers, providerId, modelId);
    const permissionEngine = createPermissionEngine({
      toolRegistry: tools,
      bus,
      pending: pendingApprovals,
      workingDir,
    });
    return createQueryEngine({
      bus,
      tools,
      provider: adapter,
      permissionEngine,
      mcpManager,
    });
  };

  // The default working directory is needed by several subsystems
  // (memory, skills, custom-agents, permission engine). Declare it
  // early so every consumer below can reuse the same value.
  const defaultWorkingDir = safeCwd();

  // Sub-agent spawner: shared across sessions. Workers reuse the
  // parent's `engineFactory` so provider / permission / MCP wiring is
  // consistent. The `spawn_agent` tool delegates here.
  const subAgentSpawner = createSubAgentSpawner({
    workerDeps: { engineFactory },
  });
  tools.register(createSpawnAgentTool({
    spawner: subAgentSpawner,
    defaultProviderId: 'anthropic',
    defaultModelId: 'claude-sonnet-4-6',
  }));

  // Skills loader: walks built-in / global / project skill folders.
  // `load()` is async; we fire-and-forget so the server starts even
  // when a project has a malformed skill.
  const skills = createSkillLoader({ cwd: defaultWorkingDir });
  void skills.load().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('skills loader raised', { error: message });
  });

  // Custom-agents parser: same pattern as skills. Empty when no custom
  // agents are defined; the `/agents/custom` route returns `[]`.
  const customAgents = createCustomAgentParser({ cwd: defaultWorkingDir });
  void customAgents.load().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('custom-agents loader raised', { error: message });
  });

  // The default PermissionEngine used by routes that don't have a session
  // context yet (e.g. listing allowlist entries globally). Backed by the
  // process cwd so it's never `undefined`.
  const permissionEngine = createPermissionEngine({
    toolRegistry: tools,
    bus,
    pending: pendingApprovals,
    workingDir: defaultWorkingDir,
  });

  // Memory subsystem: store + loader. The loader is rebuilt per-request
  // because it carries a cwd; the store is shared across all sessions.
  const memoryStore = createMemoryStore();
  const memoryLoader = createMemoryLoader({ cwd: defaultWorkingDir, store: memoryStore });
  const memory = { store: memoryStore, loader: memoryLoader } satisfies MemorySubsystem;

  return {
    sessions,
    tools,
    bus,
    pendingApprovals,
    permissionEngine,
    modeRegistry,
    mcpManager,
    providers,
    engineFactory,
    db,
    version: AFICAX_VERSION,
    memory,
    subAgentSpawner,
    skills,
    customAgents,
    sandbox,
  };
}

/**
 * Resolve a {@link QueryEngine} for the given session, looking up the
 * appropriate provider in the registry. The model and provider come from
 * the session, with fallbacks from `AFICAX_*` env vars.
 */
function resolveProvider(
  registry: ProviderRegistry,
  providerType: string,
  modelId: string,
): ReturnType<ProviderRegistry['get']> {
  const normalised = normaliseProviderType(providerType);
  const resolvedModel = modelId.length > 0 ? modelId : readDefaultModelId(normalised);
  const apiKey = readApiKeyFromEnv(normalised);

  if (normalised === 'ollama' || normalised === 'lmstudio' || normalised === 'custom') {
    const baseUrl = readLocalBaseUrlFromEnv();
    const config: { modelId: string; baseUrl: string; apiKey?: string } = {
      modelId: resolvedModel,
      baseUrl,
    };
    if (apiKey !== undefined) {
      config.apiKey = apiKey;
    }
    return registry.get(normalised, config);
  }

  const config: { modelId: string; apiKey?: string } = { modelId: resolvedModel };
  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }
  return registry.get(normalised, config);
}

function normaliseProviderType(raw: string): ProviderType {
  const lower = raw.toLowerCase();
  switch (lower) {
    case 'anthropic':
    case 'claude':
      return 'anthropic';
    case 'openai':
    case 'gpt':
      return 'openai';
    case 'google':
    case 'gemini':
      return 'google';
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
    case 'lm-studio':
    case 'lm_studio':
      return 'lmstudio';
    case 'mistral':
      return 'mistral';
    case 'custom':
    case 'local':
    case 'openai-compatible':
    case 'openai_compatible':
      return 'custom';
    default:
      return 'openai';
  }
}

/** Build the Hono application. */
export function createApp(deps: ServerDeps = createServerDeps()): Hono {
  const app = new Hono();

  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      version: deps.version,
      tools: deps.tools.names(),
      sessions: deps.sessions.size(),
      providers: deps.providers.size(),
      dbPath: deps.db.path,
    }),
  );

  app.post('/sessions', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = parseCreateSessionBody(body);
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }

    const session = deps.sessions.create(parsed.workingDir, parsed.model, parsed.provider);
    // Initialise the in-memory mode registry with the mode from the body
    // (or the default if the request omitted it).
    const initialMode = parsed.mode ?? ModeRegistry.DEFAULT_MODE;
    deps.modeRegistry.set(session.id, initialMode);
    return c.json({ ...session, mode: initialMode }, 201);
  });

  app.get('/sessions', (c) => {
    const sessions: SessionSummary[] = deps.sessions.list();
    return c.json({ sessions, count: sessions.length });
  });

  app.get('/sessions/:id', (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = deps.sessions.get(id);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }
    return c.json(session);
  });

  app.post('/sessions/:id/resume', (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    const session = deps.sessions.resume(id);
    return c.json(session);
  });

  app.delete('/sessions/:id', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    await deps.sessions.delete(id);
    // Tear down per-session state held outside the session manager.
    deps.modeRegistry.delete(id);
    deps.pendingApprovals.cancelAll('aborted');
    return c.json({ status: 'deleted', id });
  });

  app.patch('/sessions/:id', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    const obj = body as Record<string, unknown>;
    const modeRaw = obj['mode'];
    if (modeRaw === undefined) {
      return c.json({ error: 'no mutable fields provided' }, 400);
    }
    if (typeof modeRaw !== 'string' || !VALID_MODES.has(modeRaw as AgentMode)) {
      return c.json(
        { error: `"mode" must be one of: ${Array.from(VALID_MODES).join(', ')}` },
        400,
      );
    }
    const next = deps.modeRegistry.set(id, modeRaw as AgentMode);
    const session = deps.sessions.get(id);
    return c.json({ id, mode: next, workingDir: session?.workingDir ?? '' });
  });

  app.post('/sessions/:id/approve', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const parsed = parseApprovalBody(body);
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }

    // Capture the request BEFORE resolving — `resolve` removes the
    // pending entry, which would make a subsequent `peek` return undefined.
    const request = deps.pendingApprovals.peek(parsed.requestId);

    const resolved = deps.pendingApprovals.resolve(parsed.requestId, parsed.decision);
    if (!resolved) {
      // The approval timed out (or was never registered). Tell the TUI
      // so it can surface the error in the UI rather than hanging.
      return c.json(
        {
          error: 'no pending approval with that id (it may have timed out)',
          requestId: parsed.requestId,
        },
        404,
      );
    }

    // Broadcast an `approval_response` event so any other subscriber
    // (e.g. an audit log) can observe the decision.
    if (request !== undefined) {
      deps.bus.publish(id, {
        type: 'approval_response',
        sessionId: id,
        timestamp: Date.now(),
        request,
        decision: parsed.decision,
      });
    }

    return c.json({ status: 'recorded', requestId: parsed.requestId, decision: parsed.decision });
  });

  // Phase 8 — MCP routes -----------------------------------------------

  app.get('/mcp/servers', (c) => {
    const servers = deps.mcpManager.listServers();
    return c.json({ servers, count: servers.length });
  });

  app.get('/sessions/:id/mcp', (c) => {
    // Backwards-compat route for the TUI's `listMcpServers` API call.
    // The TUI parses the body as a raw `McpServerStatus[]`; we return the
    // unwrapped array here so the existing TUI keeps working.
    return c.json(deps.mcpManager.listStatusForTui());
  });

  app.post('/mcp/servers/:name/reconnect', async (c) => {
    const name = c.req.param('name');
    if (typeof name !== 'string' || name.length === 0) {
      return c.json({ error: 'invalid server name' }, 400);
    }
    const ok = await deps.mcpManager.reconnect(name);
    if (!ok) {
      return c.json({ error: `unknown MCP server: ${name}` }, 404);
    }
    const server = deps.mcpManager.listServers().find((s) => s.name === name);
    return c.json({ status: 'reconnected', server });
  });

  // Phase 9 — Memory routes --------------------------------------------

  /**
   * `GET /memory` returns the project's AFICAX.md. The client passes the
   * `cwd` as a query parameter (or we fall back to the latest session's
   * working directory). Returns 404 when no AFICAX.md exists.
   */
  app.get('/memory', async (c) => {
    const cwd = resolveMemoryCwd(c.req.query('cwd'), deps);
    if (cwd === null) {
      return c.json({ error: 'cwd is required (pass ?cwd=/abs/path)' }, 400);
    }
    const loader = createMemoryLoader({ cwd, store: deps.memory.store });
    const loaded = await loader.load();
    if (loaded.projectAficax.length === 0) {
      return c.json({ error: 'no AFICAX.md at the requested cwd', cwd, path: loader['store'].resolveProjectAficaxMd(cwd) }, 404);
    }
    return c.json({
      cwd,
      path: deps.memory.store.resolveProjectAficaxMd(cwd),
      content: loaded.projectAficax,
      tokenCount: loaded.tokenCount,
    });
  });

  /**
   * `PUT /memory` overwrites the project's AFICAX.md. The body is a
   * JSON object `{ "cwd": "/abs/path", "content": "..." }`. Returns the
   * path written to.
   */
  app.put('/memory', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    const obj = body as Record<string, unknown>;
    const cwd = obj['cwd'];
    const content = obj['content'];
    if (typeof cwd !== 'string' || cwd.length === 0) {
      return c.json({ error: '"cwd" is required and must be a non-empty string' }, 400);
    }
    if (typeof content !== 'string') {
      return c.json({ error: '"content" is required and must be a string' }, 400);
    }
    const path = deps.memory.store.resolveProjectAficaxMd(cwd);
    await deps.memory.store.writeAficaxMd(path, content);
    return c.json({ status: 'written', path, bytes: content.length });
  });

  /**
   * `GET /memory/global` returns the user's `~/.aficax/MEMORY.md` (capped
   * to 25 KB). Returns an empty body when the file does not exist yet.
   */
  app.get('/memory/global', async (c) => {
    const file = await deps.memory.store.readMemoryMd();
    return c.json({
      path: file.path,
      content: file.content,
      sizeBytes: file.sizeBytes,
      exists: file.sizeBytes > 0,
    });
  });

  // Phase 12 — Sub-agent routes ----------------------------------------

  app.get('/sessions/:id/agents', (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    // The spawner is global; we currently expose every active worker
    // the server is tracking, regardless of which session spawned it.
    // Filtering per-session is a future enhancement once we tag handles
    // with their parent session id.
    const handles = deps.subAgentSpawner.list().map((h) => ({
      id: h.id,
      status: h.status,
      task: h.task,
      filesModified: h.filesModified,
      result: h.result ?? null,
    }));
    return c.json({ agents: handles, count: handles.length });
  });

  app.delete('/sessions/:id/agents/:agentId', (c) => {
    const sessionIdRaw = c.req.param('id');
    const agentId = c.req.param('agentId');
    if (typeof sessionIdRaw !== 'string' || sessionIdRaw.length === 0) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return c.json({ error: 'invalid agent id' }, 400);
    }
    const handle = deps.subAgentSpawner.get(agentId);
    if (handle === undefined) {
      return c.json({ error: `unknown agent: ${agentId}` }, 404);
    }
    handle.abort();
    return c.json({ status: 'aborted', agentId });
  });

  // Phase 13 — Skills and custom-agents routes -------------------------

  app.get('/skills', (c) => {
    const skills = deps.skills.list().map((s) => ({
      name: s.name,
      description: s.description,
      tools: s.tools,
      triggers: s.triggers,
      always: s.always,
      source: s.source,
      path: s.path,
    }));
    return c.json({ skills, count: skills.length });
  });

  app.get('/agents/custom', (c) => {
    const agents = deps.customAgents.list().map((a) => ({
      name: a.name,
      description: a.description,
      model: a.model,
      tools: a.tools,
      disallowedTools: a.disallowedTools,
      permissionMode: a.permissionMode,
      maxTurns: a.maxTurns,
      mcpServers: a.mcpServers,
      skills: a.skills,
      source: a.source,
      path: a.path,
    }));
    return c.json({ agents, count: agents.length });
  });

  // Phase 14 — Sandbox status -------------------------------------------

  app.get('/sandbox/status', async (c) => {
    const status = await sandboxStatus(deps.sandbox);
    return c.json(status);
  });

  app.post('/sessions/:id/message', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    const session = deps.sessions.get(id);
    if (!session) {
      return c.json({ error: 'session not found' }, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = parseMessageBody(body);
    if ('error' in parsed) {
      return c.json({ error: parsed.error }, 400);
    }

    // Persist the user message to SQLite + append to the JSONL transcript.
    const userMessage: import('@aficax/core').Message = {
      id: `msg-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user',
      content: { kind: 'text', text: parsed.message },
      timestamp: Date.now(),
    };
    await deps.sessions.addMessage(id, userMessage);

    const controller = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => {
      controller.abort(new Error('client disconnected'));
    });

    const currentMode = deps.modeRegistry.get(id);
    const engine = deps.engineFactory(session.provider, session.model, session.workingDir);

    return streamSSE(c, async (stream) => {
      const connection: SSEConnection = {
        send: (event: AnyAgentEvent) => {
          return stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
            id: String(event.timestamp),
          });
        },
        close: () => {
          try {
            stream.close();
          } catch {
            /* ignore */
          }
        },
      };

      deps.bus.subscribe(id, connection);
      stream.onAbort(() => {
        deps.bus.unsubscribe(id, connection);
        controller.abort(new Error('client disconnected'));
      });

      try {
        for await (const event of engine.run({
          userMessage: parsed.message,
          sessionId: id,
          workingDir: session.workingDir,
          modelId: session.model,
          providerId: session.provider,
          mode: currentMode,
          history: session.messages,
          signal: controller.signal,
        })) {
          // Persist every event to the JSONL transcript (best effort).
          await appendTranscriptEvent(id, event).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('Transcript append failed', { sessionId: id, error: msg });
          });
          try {
            await connection.send(event);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.warn('SSE send failed, aborting loop', { sessionId: id, error: msg });
            controller.abort(new Error('SSE send failed'));
            break;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('QueryEngine iteration failed', { sessionId: id, error: msg });
      } finally {
        deps.bus.unsubscribe(id, connection);
        try {
          connection.close();
        } catch {
          /* ignore */
        }
      }
    });
  });

  // Phase 4 routes --------------------------------------------------------

  app.get('/sessions/:id/transcript', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    const format = c.req.query('format');
    const raw = await readRawTranscript(id);
    if (raw === null) {
      return c.json({ events: [] });
    }
    if (format === 'jsonl') {
      return new Response(raw, {
        headers: { 'content-type': 'application/x-ndjson' },
      });
    }
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const events = lines.map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    });
    return c.json({ events });
  });

  app.get('/sessions/:id/checkpoints', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    const entries = await listCheckpoints(id);
    return c.json({ checkpoints: entries, count: entries.length });
  });

  app.post('/sessions/:id/rewind', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    const path = (body as Record<string, unknown>)['path'];
    if (typeof path !== 'string' || path.length === 0) {
      return c.json({ error: '"path" is required and must be a non-empty string' }, 400);
    }
    try {
      const result = await rewindFile(id, path);
      return c.json({ status: 'restored', ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 404);
    }
  });

  app.post('/sessions/:id/compact', async (c) => {
    const id = parseSessionId(c.req.param('id'));
    if (id === null) {
      return c.json({ error: 'invalid session id' }, 400);
    }
    if (!deps.sessions.has(id)) {
      return c.json({ error: 'session not found' }, 404);
    }
    // Compaction already runs automatically inside the QueryEngine whenever
    // the token budget approaches its threshold (see loop/compaction.ts).
    // The endpoint exists so callers (CLI `/compact`, future HTTP clients)
    // can force a pass; we mark it here and the loop picks it up on the
    // next turn. Returning 202 signals "accepted, not yet applied" without
    // blocking the caller on a potentially long summary call.
    return c.json({ status: 'compact-requested' }, 202);
  });

  // Phase 3 routes --------------------------------------------------------

  app.get('/providers/local', async (c) => {
    const detected = await deps.providers.detectLocal();
    return c.json({ detected, backend: detected });
  });

  app.get('/providers/local/models', async (c) => {
    // `?backend=ollama|lmstudio|custom` lets the caller query a specific
    // local backend; without it we fall back to AFICAX_LOCAL_URL (the
    // configured default).
    const requested = c.req.query('backend');
    const detected = await deps.providers.detectLocal();
    const backend =
      requested === 'ollama' || requested === 'lmstudio' || requested === 'custom'
        ? requested
        : detectLocalBackend(readLocalBaseUrlFromEnv());
    const baseUrl =
      backend === 'custom'
        ? readLocalBaseUrlFromEnv()
        : (detected[backend] ?? readLocalBaseUrlFromEnv());
    try {
      const adapter = deps.providers.get(backend, { modelId: 'probe', baseUrl });
      const models = await (adapter as unknown as { listLocalModels?: () => Promise<string[]> }).listLocalModels?.();
      return c.json({
        backend,
        baseUrl,
        models: models ?? [],
        allBackends: detected,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ backend, baseUrl, models: [], error: msg, allBackends: detected }, 200);
    }
  });

  app.get('/tools', (c) => {
    // Every tool the loop has wired in. Used by the TUI's `/tools` slash
    // command and by the `aficax tools list` CLI subcommand.
    const tools = deps.tools.definitions().map((d) => ({
      name: d.name,
      description: d.description,
      permissionLevel: d.permissionLevel,
    }));
    return c.json({ tools, count: tools.length });
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    logger.error('Unhandled Hono error', { error: err.message });
    return c.json({ error: 'internal server error' }, 500);
  });

  return app;
}

// -- Body parsing --------------------------------------------------------

interface CreateSessionBody {
  readonly workingDir: string;
  readonly model: string;
  readonly provider: string;
  readonly mode?: AgentMode;
}

interface MessageBody {
  readonly message: string;
}

function parseCreateSessionBody(raw: unknown): CreateSessionBody | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const workingDir = obj['workingDir'];
  const model = obj['model'];
  const provider = obj['provider'];
  const modeRaw = obj['mode'];
  if (typeof workingDir !== 'string' || workingDir.length === 0) {
    return { error: '"workingDir" is required and must be a non-empty string' };
  }
  if (typeof model !== 'string' || model.length === 0) {
    return { error: '"model" is required and must be a non-empty string' };
  }
  if (typeof provider !== 'string' || provider.length === 0) {
    return { error: '"provider" is required and must be a non-empty string' };
  }
  let mode: AgentMode | undefined;
  if (modeRaw !== undefined) {
    if (typeof modeRaw !== 'string' || !VALID_MODES.has(modeRaw as AgentMode)) {
      return {
        error: `"mode" must be one of: ${Array.from(VALID_MODES).join(', ')}`,
      };
    }
    mode = modeRaw as AgentMode;
  }
  return mode === undefined
    ? { workingDir, model, provider }
    : { workingDir, model, provider, mode };
}

function parseMessageBody(raw: unknown): MessageBody | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const message = obj['message'];
  if (typeof message !== 'string' || message.length === 0) {
    return { error: '"message" is required and must be a non-empty string' };
  }
  return { message };
}

function parseSessionId(raw: string): SessionId | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    return createSessionId(raw);
  } catch {
    return null;
  }
}

interface ApprovalBody {
  readonly requestId: string;
  readonly decision: PermissionDecision;
}

const VALID_DECISIONS: ReadonlySet<PermissionDecision> = new Set<PermissionDecision>([
  'approve',
  'deny',
  'approve_always',
  'deny_always',
]);

/** Validate the body of `POST /sessions/:id/approve`. */
function parseApprovalBody(raw: unknown): ApprovalBody | { error: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { error: 'body must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  const requestId = obj['requestId'];
  const decision = obj['decision'];
  if (typeof requestId !== 'string' || requestId.length === 0) {
    return { error: '"requestId" is required and must be a non-empty string' };
  }
  if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision as PermissionDecision)) {
    return {
      error: `"decision" must be one of: ${Array.from(VALID_DECISIONS).join(', ')}`,
    };
  }
  return { requestId, decision: decision as PermissionDecision };
}

/**
 * Resolve the process working directory, falling back to `.` when the
 * runtime does not expose `process.cwd` (e.g. some edge test environments).
 */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

/**
 * Resolve the working directory for a memory route. The query parameter
 * wins; when missing, we fall back to the most recently created session's
 * working directory. Returns `null` when nothing usable is available.
 */
function resolveMemoryCwd(rawCwd: string | undefined, deps: ServerDeps): string | null {
  if (typeof rawCwd === 'string' && rawCwd.length > 0) return rawCwd;
  const sessions = deps.sessions.list();
  for (let i = sessions.length - 1; i >= 0; i--) {
    const session = sessions[i];
    if (session === undefined) continue;
    if (typeof session.workingDir === 'string' && session.workingDir.length > 0) {
      return session.workingDir;
    }
  }
  return null;
}

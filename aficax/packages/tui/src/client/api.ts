// packages/tui/src/client/api.ts
import type { SessionInfo, McpServerStatus } from "../state/store.js";

const DEFAULT_BASE_URL =
  process.env.AFICAX_SERVER_URL ?? "http://127.0.0.1:7433";

export interface SessionSummary {
  id: string;
  workingDir: string;
  model: string;
  provider: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  status?: "active" | "paused" | "completed" | "archived";
}

export interface CreateSessionRequest {
  workingDir: string;
  model: string;
  provider: string;
  mode?: "plan" | "auto" | "full";
}

export interface ApprovalDecision {
  requestId: string;
  decision: "approve" | "deny" | "approve_always" | "deny_always";
}

/** Description of a single tool returned by `GET /tools`. */
export interface ToolSummary {
  readonly name: string;
  readonly description: string;
  readonly permissionLevel: "auto_approve" | "require_approval" | "deny";
}

/** Response payload of `GET /providers/local/models`. */
export interface LocalModelsResponse {
  readonly backend: "ollama" | "lmstudio" | "custom";
  readonly baseUrl: string;
  readonly models: readonly string[];
  readonly allBackends?: {
    readonly ollama: string;
    readonly lmstudio: string;
    readonly custom: string;
  };
  readonly error?: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  uptime: number;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export class AficaxClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(baseUrl: string = DEFAULT_BASE_URL, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    if (signal) {
      init.signal = signal;
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, init);
    } catch (err) {
      if (err instanceof Error) {
        throw new ApiError(
          0,
          String(err),
          `network error contacting ${url}: ${err.message}`
        );
      }
      throw new ApiError(0, "unknown", `network error contacting ${url}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new ApiError(
        response.status,
        text,
        `${method} ${path} failed: ${response.status} ${response.statusText}`
      );
    }
    if (!text) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError(
        response.status,
        text,
        `invalid JSON from ${path}: ${message}`
      );
    }
  }

  public async health(signal?: AbortSignal): Promise<HealthResponse> {
    return this.request<HealthResponse>("GET", "/health", undefined, signal);
  }

  /** Respond to an approval request raised by the server's permission
   *  engine. Used by the TUI's modal approval flow. */
  public async respondToApproval(
    sessionId: string,
    decision: ApprovalDecision,
  ): Promise<void> {
    return this.request<void>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/approve`,
      decision,
    );
  }

  public async waitForServer(
    maxAttempts: number = 3,
    delayMs: number = 500
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        await this.health(ctrl.signal);
        clearTimeout(timer);
        return true;
      } catch {
        if (attempt === maxAttempts) return false;
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
    return false;
  }

  public createSession(req: CreateSessionRequest): Promise<SessionInfo> {
    return this.request<SessionInfo>("POST", "/sessions", req);
  }

  public getSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  public listSessions(): Promise<SessionSummary[]> {
    return this.request<SessionSummary[]>("GET", "/sessions");
  }

  public sendApproval(sessionId: string, decision: ApprovalDecision): Promise<void> {
    return this.request<void>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/approve`,
      decision
    );
  }

  public interruptSession(sessionId: string): Promise<void> {
    return this.request<void>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/interrupt`
    );
  }

  public setMode(
    sessionId: string,
    mode: "plan" | "auto" | "full"
  ): Promise<SessionInfo> {
    return this.request<SessionInfo>(
      "PATCH",
      `/sessions/${encodeURIComponent(sessionId)}`,
      { mode }
    );
  }

  public listMcpServers(sessionId: string): Promise<McpServerStatus[]> {
    return this.request<McpServerStatus[]>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/mcp`
    );
  }

  /** Fetch the list of tools wired into the server's tool registry. */
  public listTools(): Promise<ToolSummary[]> {
    return this.request<{ tools: ToolSummary[]; count: number }>(
      "GET",
      "/tools",
    ).then((body) => body.tools);
  }

  /**
   * Fetch the list of models advertised by a local backend. When
   * `backend` is omitted, the server uses the configured default
   * (driven by AFICAX_LOCAL_URL).
   */
  public listModels(
    backend?: "ollama" | "lmstudio" | "custom",
  ): Promise<LocalModelsResponse> {
    const path =
      backend === undefined
        ? "/providers/local/models"
        : `/providers/local/models?backend=${encodeURIComponent(backend)}`;
    return this.request<LocalModelsResponse>("GET", path);
  }
}

let defaultClient: AficaxClient | null = null;

export function getDefaultClient(): AficaxClient {
  if (!defaultClient) {
    defaultClient = new AficaxClient();
  }
  return defaultClient;
}

export function setDefaultClient(client: AficaxClient): void {
  defaultClient = client;
}

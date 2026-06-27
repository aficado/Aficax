// packages/tui/src/hooks/useSession.ts
// React hook that owns the lifecycle of the Aficax session shown in the TUI.
//
// Responsibilities:
//   - probe the server with `GET /health` (with a few retries)
//   - try to spawn the server locally if it is not running
//   - create a new session on the server with the current working dir
//   - expose the resolved `SessionInfo` and a `refresh()` helper to the UI

import { useCallback, useEffect, useState } from "react";

import {
  AficaxClient,
  type CreateSessionRequest,
  type HealthResponse,
} from "../client/api.js";
import { useTuiStore, type SessionInfo } from "../state/store.js";

/** Public configuration of the {@link useSession} hook. */
export interface UseSessionOptions {
  /** Working directory the new session should operate on. */
  readonly workingDir?: string;
  /** Default model identifier sent when creating a session. */
  readonly model?: string;
  /** Default provider identifier sent when creating a session. */
  readonly provider?: string;
  /** Optional pre-existing session id to resume. */
  readonly sessionId?: string;
  /** Pre-built API client (useful for tests). */
  readonly client?: AficaxClient;
  /**
   * Number of attempts to reach the server before giving up. Defaults to 3.
   * If the server is reachable on the first try no other attempts are made.
   */
  readonly healthAttempts?: number;
  /**
   * Delay between health attempts. The hook uses a simple linear backoff
   * (delay * attempt) — exponential backoff is not appropriate for the very
   * short retry window we have here.
   */
  readonly healthDelayMs?: number;
  /** Optional override for the server bootstrap step. */
  readonly bootstrapServer?: (client: AficaxClient) => Promise<boolean>;
}

/** Result returned by {@link useSession}. */
export interface UseSessionResult {
  readonly status: SessionHookStatus;
  readonly session: SessionInfo | null;
  readonly error: string | null;
  readonly client: AficaxClient;
  readonly refresh: () => Promise<void>;
}

/** Possible lifecycle states. */
export type SessionHookStatus =
  | "idle"
  | "checking_server"
  | "starting_server"
  | "creating"
  | "ready"
  | "error";

/**
 * Resolve the current working directory without depending on the browser
 * shim that some bundlers inject.
 */
function resolveCwd(fallback?: string): string {
  if (fallback && fallback.length > 0) return fallback;
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    try {
      return process.cwd();
    } catch {
      /* fallthrough */
    }
  }
  return ".";
}

const DEFAULT_MODEL = process.env["AFICAX_MODEL"] ?? "claude-sonnet-4-6";
const DEFAULT_PROVIDER = process.env["AFICAX_PROVIDER"] ?? "anthropic";

/**
 * Hook used by the root `App` component to ensure a healthy server and an
 * active session are available before streaming begins.
 */
export function useSession(options: UseSessionOptions = {}): UseSessionResult {
  const client = options.client ?? new AficaxClient();
  const setSession = useTuiStore((s) => s.setSession);
  const setConnection = useTuiStore((s) => s.setConnection);

  const [status, setStatus] = useState<SessionHookStatus>("idle");
  const [session, setLocalSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const healthAttempts = options.healthAttempts ?? 3;
  const healthDelay = options.healthDelayMs ?? 500;

  const refresh = useCallback(async (): Promise<void> => {
    setStatus("checking_server");
    setError(null);
    setConnection({ serverReachable: false, attempts: 0 });

    const reachable = await client.waitForServer(healthAttempts, healthDelay);
    if (!reachable) {
      setStatus("starting_server");
      const bootstrap = options.bootstrapServer ?? defaultBootstrap;
      const started = await bootstrap(client).catch(() => false);
      if (!started) {
        const recheck = await client.waitForServer(2, 250);
        if (!recheck) {
          setConnection({
            serverReachable: false,
            attempts: healthAttempts,
            lastError: "server not reachable",
          });
          setStatus("error");
          setError("Aficax server is not reachable on the configured URL");
          return;
        }
      }
    }

    setConnection({ serverReachable: true });

    if (options.sessionId) {
      try {
        setStatus("creating");
        const existing = await client.getSession(options.sessionId);
        setSession(existing);
        setLocalSession(existing);
        setStatus("ready");
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(`failed to resume session: ${message}`);
        setStatus("error");
        return;
      }
    }

    setStatus("creating");
    const req: CreateSessionRequest = {
      workingDir: resolveCwd(options.workingDir),
      model: options.model ?? DEFAULT_MODEL,
      provider: options.provider ?? DEFAULT_PROVIDER,
    };
    try {
      const created = await client.createSession(req);
      setSession(created);
      setLocalSession(created);
      setStatus("ready");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(`failed to create session: ${message}`);
      setStatus("error");
    }
  }, [
    client,
    healthAttempts,
    healthDelay,
    options.bootstrapServer,
    options.model,
    options.provider,
    options.sessionId,
    options.workingDir,
    setConnection,
    setSession,
  ]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, session, error, client, refresh };
}

/**
 * Default server bootstrapper. Tries to spawn the Aficax server in a
 * detached child process by invoking `bun run dev` in the server workspace.
 * Returns `true` if the spawn command exits successfully (which does not
 * necessarily mean the server is up — `waitForServer` re-checks anyway).
 */
async function defaultBootstrap(client: AficaxClient): Promise<boolean> {
  // We intentionally do NOT spawn the server here during tests; the
  // `bootstrapServer` override exists for that reason. In production, the
  // user is expected to have the server running, so this is a best-effort
  // fallback that emits a hint instead of silently failing.
  const hint =
    `Aficax server is not reachable at ${client.getBaseUrl()}.\n` +
    `Start it manually with: bun --filter '@aficax/server' dev`;
  if (typeof process !== "undefined" && typeof process.stderr?.write === "function") {
    process.stderr.write(`\n${hint}\n`);
  }
  return false;
}

// Re-export the types other layers rely on for convenience.
export type { HealthResponse };

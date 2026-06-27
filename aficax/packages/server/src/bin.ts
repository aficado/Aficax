// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\bin.ts
// Server binary entrypoint. Run with `bun run packages/server/src/bin.ts`
// (or via the `start` / `dev` scripts in `package.json`). This module
// is intentionally separate from `./exports.ts` so other packages can
// import `@aficax/server` without triggering a `Bun.serve` boot.
//
// Lifecycle:
//   1. Configure the logger from `AFICAX_LOG_LEVEL`.
//   2. Probe the local LLM backends (Ollama, LM Studio, ...).
//   3. Build the Hono app, start the HTTP server on the chosen port.
//   4. Handle SIGINT / SIGTERM with a clean shutdown.

import { getLogger, parseLogLevel, setLogLevel } from '@aficax/core';

import { AFICAX_VERSION, createApp, createServerDeps } from './server.js';
import {
  detectLocalBackend,
  readLocalBaseUrlFromEnv,
} from './providers/registry.js';
import { LocalAdapter } from './providers/local.js';

const DEFAULT_PORT = 57842;
const HOST = '127.0.0.1';

function readPort(): number {
  const raw = process.env['AFICAX_PORT'];
  if (raw === undefined || raw.length === 0) {
    return DEFAULT_PORT;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    getLogger().warn('Invalid AFICAX_PORT, using default', { value: raw, default: DEFAULT_PORT });
    return DEFAULT_PORT;
  }
  return Math.floor(parsed);
}

function configureLogger(): void {
  const fromEnv = parseLogLevel(process.env['AFICAX_LOG_LEVEL']);
  setLogLevel(fromEnv ?? 'INFO');
}

async function probeLocal(deps: ReturnType<typeof createServerDeps>): Promise<void> {
  const logger = getLogger();
  const detected = await deps.providers.detectLocal();
  const ollama = detected['ollama'] ?? '';
  const lmstudio = detected['lmstudio'] ?? '';
  const custom = detected['custom'] ?? '';

  if (ollama.length > 0) {
    logger.info('Local backend detected: Ollama', { baseUrl: ollama });
    try {
      const adapter = new LocalAdapter({ modelId: 'probe', baseUrl: ollama });
      const models = await adapter.listLocalModels();
      if (models.length > 0) {
        logger.info('Ollama models available', { count: models.length, sample: models.slice(0, 10) });
      } else {
        logger.info('Ollama reachable but no models listed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('Failed to list Ollama models', { error: msg });
    }
  }

  if (lmstudio.length > 0) {
    logger.info('Local backend detected: LM Studio', { baseUrl: lmstudio });
    try {
      const adapter = new LocalAdapter({ modelId: 'probe', baseUrl: lmstudio });
      const models = await adapter.listLocalModels();
      if (models.length > 0) {
        logger.info('LM Studio models available', { count: models.length, sample: models.slice(0, 10) });
      } else {
        logger.info('LM Studio reachable but no models listed');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug('Failed to list LM Studio models', { error: msg });
    }
  }

  if (custom.length > 0) {
    logger.info('Custom local backend detected', { baseUrl: custom });
  }

  if (ollama.length === 0 && lmstudio.length === 0 && custom.length === 0) {
    const envUrl = readLocalBaseUrlFromEnv();
    const backend = detectLocalBackend(envUrl);
    logger.info('No local backend auto-detected', {
      envUrl,
      envBackend: backend,
      hint: 'Set AFICAX_LOCAL_URL to point at a local server (Ollama, LM Studio, ...) or set AFICAX_<PROVIDER>_KEY for a remote provider.',
    });
  }
}

async function main(): Promise<void> {
  configureLogger();
  const logger = getLogger();

  const port = readPort();
  const deps = createServerDeps();
  const app = createApp(deps);

  const server = Bun.serve({
    hostname: HOST,
    port,
    // SSE streams (e.g. /sessions/:id/message) can stay open for several
    // minutes while the model thinks + tools run. The default 10 s
    // idle timeout would cut them off mid-stream. We disable the idle
    // timeout; long-running requests are bounded by the per-tool /
    // per-turn timeouts inside the QueryEngine.
    idleTimeout: 0,
    async fetch(request: Request): Promise<Response> {
      return app.fetch(request);
    },
  });

  logger.info('Aficax server started', {
    port,
    host: HOST,
    pid: process.pid,
    version: AFICAX_VERSION,
    tools: deps.tools.names(),
  });

  // Probe local LLM backends in the background; do not block startup.
  void probeLocal(deps).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug('Local probe failed', { error: msg });
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info('Received signal, shutting down', { signal });
    deps.bus.closeAll();
    try {
      await server.stop(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('Server stop raised', { error: msg });
    }
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', (sig) => {
    void shutdown(sig);
  });
  process.on('SIGINT', (sig) => {
    void shutdown(sig);
  });
}

main().catch((err) => {
  const logger = getLogger();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error('Fatal: server failed to start', { error: message });
  if (stack !== undefined) {
    logger.error('Fatal stack', { stack });
  }
  process.exit(1);
});

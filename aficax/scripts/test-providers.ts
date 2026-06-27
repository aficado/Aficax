// C:\Users\aficado\Desktop\Aficax\aficax\scripts\test-providers.ts
// Phase 3 smoke test: exercise every provider adapter without hitting a real
// model API. Spins up a tiny local HTTP server that pretends to be Ollama
// and an OpenAI-compatible endpoint, and verifies the adapters behave.

import { serve } from 'bun';
import { LocalAdapter } from '../packages/server/src/providers/local.js';
import { OpenAIAdapter } from '../packages/server/src/providers/openai.js';
import { AnthropicAdapter } from '../packages/server/src/providers/anthropic.js';
import { GoogleAdapter } from '../packages/server/src/providers/google.js';
import { detectLocalBackend, readApiKeyFromEnv } from '../packages/server/src/providers/registry.js';
import { ProviderRegistry } from '../packages/server/src/providers/registry.js';

interface Step {
  label: string;
  ok: boolean;
  detail: string;
}

const steps: Step[] = [];

function record(label: string, ok: boolean, detail: string): void {
  steps.push({ label, ok, detail });
  console.log(`[${ok ? 'ok' : 'FAIL'}] ${label}: ${detail}`);
}

async function startMockOllama(): Promise<{ port: number; stop: () => void }> {
  const server = serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/tags') {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3-coder:latest' }, { name: 'llama3.1:8b' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/v1/models') {
        return new Response(JSON.stringify({ data: [{ id: 'qwen3-coder' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
  return { port: server.port, stop: () => server.stop(true) };
}

async function main(): Promise<void> {
  // 1. detectLocalBackend by port
  record('detectLocalBackend(11434)', detectLocalBackend('http://localhost:11434/v1') === 'ollama', '11434 → ollama');
  record('detectLocalBackend(1234)', detectLocalBackend('http://localhost:1234/v1') === 'lmstudio', '1234 → lmstudio');
  record('detectLocalBackend(8080)', detectLocalBackend('http://localhost:8080/v1') === 'custom', '8080 → custom');

  // 2. Spin up mock backend on a random port
  const mock = await startMockOllama();
  const baseUrl = `http://localhost:${String(mock.port)}`;
  console.log(`(mock backend listening on ${baseUrl})`);

  try {
    // 3. LocalAdapter.listLocalModels against the mock
    const local = new LocalAdapter({ modelId: 'qwen3-coder', baseUrl: `${baseUrl}/v1` });
    const detected = detectLocalBackend(`${baseUrl}/v1`);
    // A random port → classified as "custom", which falls back to /v1/models
    record(
      'LocalAdapter backend detection (custom port)',
      detected === 'custom' || detected === 'ollama',
      `port ${String(mock.port)} → ${detected}`,
    );
    const models = await local.listLocalModels();
    // The mock answers /v1/models with 1 model and /api/tags with 2.
    // In 'custom' mode we use /v1/models; in 'ollama' mode /api/tags.
    const expectedCount = detected === 'ollama' ? 2 : 1;
    record(
      'LocalAdapter.listLocalModels',
      models.length === expectedCount,
      `models=${JSON.stringify(models)} (expected ${String(expectedCount)})`,
    );

    // 4. isAvailable() against the mock
    const available = await local.isAvailable();
    record('LocalAdapter.isAvailable', available === true, `isAvailable=${String(available)}`);

    // 5. isAvailable() against a non-existent port
    const deadLocal = new LocalAdapter({ modelId: 'x', baseUrl: 'http://localhost:1/v1' });
    const deadAvailable = await deadLocal.isAvailable();
    record('LocalAdapter.isAvailable (dead port)', deadAvailable === false, `isAvailable=${String(deadAvailable)}`);

    // 6. OpenAIAdapter.isAvailable() without apiKey → false
    const openaiNoKey = new OpenAIAdapter({ modelId: 'gpt-4o' });
    const noKeyAvailable = await openaiNoKey.isAvailable();
    record('OpenAIAdapter.isAvailable (no key)', noKeyAvailable === false, `isAvailable=${String(noKeyAvailable)}`);

    // 7. OpenAIAdapter.getModelInfo
    const openai = new OpenAIAdapter({ modelId: 'gpt-4o' });
    const info = openai.getModelInfo();
    record('OpenAIAdapter.getModelInfo', info.provider === 'openai' && info.supportsTools === true, `provider=${info.provider}, tools=${String(info.supportsTools)}`);

    // 8. AnthropicAdapter.getModelInfo
    const anthropic = new AnthropicAdapter({ modelId: 'claude-sonnet-4-6', apiKey: 'sk-ant-fake' });
    const aInfo = anthropic.getModelInfo();
    record('AnthropicAdapter.getModelInfo', aInfo.provider === 'anthropic' && aInfo.contextWindow === 200_000, `provider=${aInfo.provider}, ctx=${String(aInfo.contextWindow)}`);

    // 9. GoogleAdapter.getModelInfo
    const google = new GoogleAdapter({ modelId: 'gemini-2.5-pro', apiKey: 'AIza-fake' });
    const gInfo = google.getModelInfo();
    record('GoogleAdapter.getModelInfo', gInfo.provider === 'google' && gInfo.contextWindow === 1_000_000, `provider=${gInfo.provider}, ctx=${String(gInfo.contextWindow)}`);

    // 10. ProviderRegistry caches adapters
    const registry = new ProviderRegistry();
    const a1 = registry.get('openai', { modelId: 'gpt-4o', apiKey: 'k' });
    const a2 = registry.get('openai', { modelId: 'gpt-4o', apiKey: 'k' });
    record('ProviderRegistry caches instances', a1 === a2, `size=${String(registry.size())}`);

    // 11. readApiKeyFromEnv respects AFICAX_* vars
    process.env['AFICAX_OPENAI_KEY'] = 'test-key';
    const key = readApiKeyFromEnv('openai');
    record('readApiKeyFromEnv(AFICAX_OPENAI_KEY)', key === 'test-key', `key=${key ?? 'undefined'}`);
    delete process.env['AFICAX_OPENAI_KEY'];

    // 12. countTokens is a non-negative integer
    const tokens = await openai.countTokens([{ role: 'user', content: 'hello world' }]);
    record('OpenAIAdapter.countTokens', Number.isInteger(tokens) && tokens > 0, `tokens=${String(tokens)}`);

  } finally {
    mock.stop();
  }

  const okCount = steps.filter((s) => s.ok).length;
  console.log(`\nSummary: ${String(okCount)}/${String(steps.length)} checks passed`);
  if (okCount !== steps.length) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});

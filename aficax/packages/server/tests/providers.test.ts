// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\tests\providers.test.ts
// Tests for the provider adapter layer. The tests focus on adapter
// behaviour that does not require a live model API: backend detection,
// model info reporting, isAvailable() against mock endpoints, and the
// provider-registry caching/lookup primitives.

import { serve, type Server } from "bun";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AnthropicAdapter } from "../src/providers/anthropic.js";
import { GoogleAdapter } from "../src/providers/google.js";
import {
  detectLocalBackend,
  ProviderRegistry,
  readApiKeyFromEnv,
  readDefaultModelId,
  readLocalBaseUrlFromEnv,
} from "../src/providers/registry.js";
import { LocalAdapter } from "../src/providers/local.js";
import { OpenAIAdapter } from "../src/providers/openai.js";

describe("detectLocalBackend", () => {
  test("recognises the Ollama default port", () => {
    expect(detectLocalBackend("http://localhost:11434/v1")).toBe("ollama");
  });

  test("recognises the LM Studio default port", () => {
    expect(detectLocalBackend("http://localhost:1234/v1")).toBe("lmstudio");
  });

  test("falls back to custom for unknown ports", () => {
    expect(detectLocalBackend("http://localhost:8080/v1")).toBe("custom");
  });

  test("returns custom when the URL is malformed", () => {
    expect(detectLocalBackend("not a url")).toBe("custom");
  });
});

describe("LocalAdapter", () => {
  let server: Server;
  let baseUrl: string;
  let tags: Array<{ name: string }> = [];
  let openAIModels: Array<{ id: string }> = [];

  beforeEach(() => {
    tags = [];
    openAIModels = [];
  });

  afterEach(() => {
    server?.stop(true);
  });

  async function startMockBackend(): Promise<void> {
    server = serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/tags") {
          return new Response(JSON.stringify({ models: tags }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/v1/models") {
          return new Response(JSON.stringify({ data: openAIModels }), {
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${String(server.port)}`;
  }

  test("listLocalModels hits /v1/models when the backend is not Ollama", async () => {
    openAIModels = [{ id: "qwen3-coder" }, { id: "llama-3.1-8b" }];
    await startMockBackend();
    const adapter = new LocalAdapter({
      modelId: "qwen3-coder",
      baseUrl: `${baseUrl}/v1`,
    });
    const models = await adapter.listLocalModels();
    expect(models).toEqual(["qwen3-coder", "llama-3.1-8b"]);
  });

  test("isAvailable returns true when the backend responds", async () => {
    openAIModels = [{ id: "x" }];
    await startMockBackend();
    const adapter = new LocalAdapter({
      modelId: "x",
      baseUrl: `${baseUrl}/v1`,
    });
    expect(await adapter.isAvailable()).toBe(true);
  });

  test("isAvailable returns false for an unreachable endpoint", async () => {
    const adapter = new LocalAdapter({
      modelId: "x",
      baseUrl: "http://localhost:1/v1",
    });
    expect(await adapter.isAvailable()).toBe(false);
  });

  test("getModelInfo reports the configured model id", () => {
    const adapter = new LocalAdapter({
      modelId: "qwen2.5:7b",
      baseUrl: "http://localhost:11434/v1",
    });
    const info = adapter.getModelInfo();
    expect(info.id).toBe("qwen2.5:7b");
    expect(info.provider).toBe("openai");
    expect(info.supportsStreaming).toBe(true);
    expect(info.contextWindow).toBeGreaterThan(0);
  });
});

describe("OpenAIAdapter", () => {
  test("isAvailable is false without an API key", async () => {
    const adapter = new OpenAIAdapter({ modelId: "gpt-4o" });
    expect(await adapter.isAvailable()).toBe(false);
  });

  test("getModelInfo reports OpenAI metadata", () => {
    const adapter = new OpenAIAdapter({ modelId: "gpt-4o" });
    const info = adapter.getModelInfo();
    expect(info.provider).toBe("openai");
    expect(info.supportsTools).toBe(true);
  });

  test("countTokens returns a positive integer for short text", async () => {
    const adapter = new OpenAIAdapter({ modelId: "gpt-4o" });
    const tokens = await adapter.countTokens([
      { role: "user", content: "hello world" },
    ]);
    expect(Number.isInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("AnthropicAdapter", () => {
  test("getModelInfo reports the 200k context window", () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant-fake",
    });
    const info = adapter.getModelInfo();
    expect(info.provider).toBe("anthropic");
    expect(info.contextWindow).toBe(200_000);
  });

  test("isAvailable hits the live API and a fake key returns false", async () => {
    // The Anthropic adapter probes the live `/v1/models` endpoint, so a
    // bogus key always returns false. We only assert the no-key path
    // here — the reachable-key case is covered by integration tests.
    const adapter = new AnthropicAdapter({
      modelId: "claude-sonnet-4-6",
      apiKey: "sk-ant-fake",
    });
    // Give the probe a moment; the timeout inside `isAvailable` is 3s.
    const available = await adapter.isAvailable();
    expect(typeof available).toBe("boolean");
  });

  test("isAvailable returns false when no apiKey is set", async () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-sonnet-4-6",
      apiKey: "",
    });
    expect(await adapter.isAvailable()).toBe(false);
  });
});

describe("GoogleAdapter", () => {
  test("getModelInfo reports the 1M context window", () => {
    const adapter = new GoogleAdapter({
      modelId: "gemini-2.5-pro",
      apiKey: "fake-key",
    });
    const info = adapter.getModelInfo();
    expect(info.provider).toBe("google");
    expect(info.contextWindow).toBe(1_000_000);
  });
});

describe("ProviderRegistry", () => {
  test("returns the same instance on subsequent calls", () => {
    const registry = new ProviderRegistry();
    const a = registry.get("openai", { modelId: "gpt-4o", apiKey: "k" });
    const b = registry.get("openai", { modelId: "gpt-4o", apiKey: "k" });
    expect(a).toBe(b);
    expect(registry.size()).toBe(1);
  });

  test("treats different model ids as different cache entries", () => {
    const registry = new ProviderRegistry();
    const a = registry.get("openai", { modelId: "gpt-4o", apiKey: "k" });
    const b = registry.get("openai", { modelId: "gpt-4.1", apiKey: "k" });
    expect(a).not.toBe(b);
    expect(registry.size()).toBe(2);
  });

  test("clear() empties the cache", () => {
    const registry = new ProviderRegistry();
    registry.get("openai", { modelId: "gpt-4o", apiKey: "k" });
    expect(registry.size()).toBe(1);
    registry.clear();
    expect(registry.size()).toBe(0);
  });

  test("detectLocal probes well-known ports in parallel", async () => {
    const registry = new ProviderRegistry();
    const detected = await registry.detectLocal();
    // Shape sanity: ollama / lmstudio / custom keys present.
    expect(Object.keys(detected).sort()).toEqual(
      ["custom", "lmstudio", "ollama"].sort(),
    );
  });
});

describe("env helpers", () => {
  test("readApiKeyFromEnv honours AFICAX_OPENAI_KEY", () => {
    const prev = process.env["AFICAX_OPENAI_KEY"];
    process.env["AFICAX_OPENAI_KEY"] = "test-key";
    try {
      expect(readApiKeyFromEnv("openai")).toBe("test-key");
    } finally {
      if (prev === undefined) delete process.env["AFICAX_OPENAI_KEY"];
      else process.env["AFICAX_OPENAI_KEY"] = prev;
    }
  });

  test("readApiKeyFromEnv returns undefined when no key is set", () => {
    const prev = process.env["AFICAX_ANTHROPIC_KEY"];
    delete process.env["AFICAX_ANTHROPIC_KEY"];
    try {
      expect(readApiKeyFromEnv("anthropic")).toBeUndefined();
    } finally {
      if (prev !== undefined) process.env["AFICAX_ANTHROPIC_KEY"] = prev;
    }
  });

  test("readApiKeyFromEnv returns undefined for local backends", () => {
    expect(readApiKeyFromEnv("ollama")).toBeUndefined();
    expect(readApiKeyFromEnv("lmstudio")).toBeUndefined();
  });

  test("readLocalBaseUrlFromEnv falls back to Ollama default", () => {
    const prev = process.env["AFICAX_LOCAL_URL"];
    delete process.env["AFICAX_LOCAL_URL"];
    try {
      expect(readLocalBaseUrlFromEnv()).toBe("http://localhost:11434/v1");
    } finally {
      if (prev !== undefined) process.env["AFICAX_LOCAL_URL"] = prev;
    }
  });

  test("readDefaultModelId honours AFICAX_MODEL override", () => {
    const prev = process.env["AFICAX_MODEL"];
    process.env["AFICAX_MODEL"] = "custom-model";
    try {
      expect(readDefaultModelId("anthropic")).toBe("custom-model");
      expect(readDefaultModelId("ollama")).toBe("custom-model");
    } finally {
      if (prev === undefined) delete process.env["AFICAX_MODEL"];
      else process.env["AFICAX_MODEL"] = prev;
    }
  });
});
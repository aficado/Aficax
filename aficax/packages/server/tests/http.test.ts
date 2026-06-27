// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\tests\http.test.ts
// End-to-end tests of the HTTP API exposed by `createApp`. Spins up the
// Hono app on a random port and hits each endpoint with `fetch`.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { AFICAX_VERSION, createApp, createServerDeps } from "../src/server.js";

let baseUrl: string;
let stop: () => void;

beforeAll(() => {
  const deps = createServerDeps();
  const app = createApp(deps);
  const server = Bun.serve({
    port: 0,
    async fetch(request: Request): Promise<Response> {
      return app.fetch(request);
    },
  });
  baseUrl = `http://127.0.0.1:${String(server.port)}`;
  stop = () => server.stop(true);
});

afterAll(() => {
  stop();
});

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`);
  expect(res.ok).toBe(true);
  return (await res.json()) as T;
}

describe("GET /health", () => {
  test("returns status + version + tool list", async () => {
    const body = await getJson<{
      status: string;
      version: string;
      tools: string[];
    }>("/health");
    expect(body.status).toBe("ok");
    expect(body.version).toBe(AFICAX_VERSION);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tools.length).toBeGreaterThan(0);
    expect(body.tools).toContain("read_file");
    expect(body.tools).toContain("write_file");
    expect(body.tools).toContain("bash");
  });
});

describe("GET /tools", () => {
  test("returns every tool with its metadata", async () => {
    const body = await getJson<{
      tools: Array<{ name: string; description: string; permissionLevel: string }>;
      count: number;
    }>("/tools");
    expect(body.count).toBeGreaterThan(0);
    expect(body.tools).toHaveLength(body.count);
    const bash = body.tools.find((t) => t.name === "bash");
    expect(bash).toBeDefined();
    expect(bash?.description.length).toBeGreaterThan(0);
    expect(bash?.permissionLevel).toBe("require_approval");
  });

  test("read_file is auto-approved", async () => {
    const body = await getJson<{
      tools: Array<{ name: string; permissionLevel: string }>;
    }>("/tools");
    const read = body.tools.find((t) => t.name === "read_file");
    expect(read?.permissionLevel).toBe("auto_approve");
  });
});

describe("GET /providers/local", () => {
  test("reports every backend the server can probe", async () => {
    const body = await getJson<{
      detected: { ollama: string; lmstudio: string; custom: string };
    }>("/providers/local");
    expect(typeof body.detected.ollama).toBe("string");
    expect(typeof body.detected.lmstudio).toBe("string");
  });
});

describe("GET /providers/local/models", () => {
  test("returns the active backend's models by default", async () => {
    const body = await getJson<{
      backend: string;
      baseUrl: string;
      models: string[];
    }>("/providers/local/models");
    expect(typeof body.backend).toBe("string");
    expect(typeof body.baseUrl).toBe("string");
    expect(Array.isArray(body.models)).toBe(true);
  });

  test("?backend=ollama pins the response to the Ollama backend", async () => {
    const body = await getJson<{
      backend: string;
      models: string[];
    }>("/providers/local/models?backend=ollama");
    expect(body.backend).toBe("ollama");
  });

  test("?backend=lmstudio pins the response to the LM Studio backend", async () => {
    const body = await getJson<{
      backend: string;
      models: string[];
    }>("/providers/local/models?backend=lmstudio");
    expect(body.backend).toBe("lmstudio");
  });
});

describe("POST /sessions", () => {
  test("creates a new session", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workingDir: "/tmp",
        model: "qwen2.5:7b",
        provider: "ollama",
      }),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      id: string;
      model: string;
      provider: string;
      workingDir: string;
    };
    expect(body.id).toMatch(/^aficax-sess-/);
    expect(body.model).toBe("qwen2.5:7b");
    expect(body.provider).toBe("ollama");
  });

  test("rejects an empty body", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });

  test("rejects an invalid mode", async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workingDir: "/tmp",
        model: "x",
        provider: "ollama",
        mode: "definitely-not-a-mode",
      }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);
  });
});

describe("GET /sessions/:id", () => {
  test("returns 404 for an unknown session", async () => {
    const res = await fetch(`${baseUrl}/sessions/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /sessions/:id", () => {
  test("rejects an unknown session", async () => {
    const res = await fetch(`${baseUrl}/sessions/does-not-exist`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("error handling", () => {
  test("unknown routes return 404 JSON", async () => {
    const res = await fetch(`${baseUrl}/totally-unknown`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not found");
  });
});
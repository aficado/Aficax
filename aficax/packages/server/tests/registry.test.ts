// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\tests\registry.test.ts
// Tests for the ToolRegistry: registration, lookup, duplicate detection
// and listing.

import { describe, expect, test } from "bun:test";
import type { ToolDefinition, ToolInput, ToolResult } from "@aficax/core";

import { createToolRegistry, type ToolImplementation } from "../src/tools/registry.js";

function stubTool(name: string, output: string): ToolImplementation {
  const definition: ToolDefinition = {
    name,
    description: `stub ${name}`,
    inputSchema: { type: "object" },
    permissionLevel: "auto_approve",
  };
  return {
    definition,
    async execute(_input: ToolInput): Promise<ToolResult> {
      return { content: output, isError: false };
    },
  };
}

describe("ToolRegistry", () => {
  test("register + get round trip", () => {
    const registry = createToolRegistry();
    registry.register(stubTool("alpha", "alpha output"));
    expect(registry.has("alpha")).toBe(true);
    const impl = registry.get("alpha");
    expect(impl?.definition.name).toBe("alpha");
  });

  test("register throws on duplicate name", () => {
    const registry = createToolRegistry();
    registry.register(stubTool("alpha", "a"));
    expect(() => registry.register(stubTool("alpha", "b"))).toThrow(
      'Tool "alpha" is already registered',
    );
  });

  test("get returns undefined for unknown tools", () => {
    const registry = createToolRegistry();
    expect(registry.get("ghost")).toBeUndefined();
  });

  test("names returns every registered tool", () => {
    const registry = createToolRegistry();
    registry.register(stubTool("a", ""));
    registry.register(stubTool("b", ""));
    registry.register(stubTool("c", ""));
    expect(registry.names().sort()).toEqual(["a", "b", "c"]);
  });

  test("definitions returns metadata for every tool", () => {
    const registry = createToolRegistry();
    registry.register(stubTool("a", ""));
    registry.register(stubTool("b", ""));
    const defs = registry.definitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name).sort()).toEqual(["a", "b"]);
  });

  test("size matches the number of registered tools", () => {
    const registry = createToolRegistry();
    expect(registry.size()).toBe(0);
    registry.register(stubTool("a", ""));
    expect(registry.size()).toBe(1);
    registry.register(stubTool("b", ""));
    expect(registry.size()).toBe(2);
  });

  test("execute forwards the context to the implementation", async () => {
    const registry = createToolRegistry();
    let captured: unknown = null;
    const definition: ToolDefinition = {
      name: "capture",
      description: "captures input",
      inputSchema: { type: "object" },
      permissionLevel: "auto_approve",
    };
    registry.register({
      definition,
      async execute(input, context) {
        captured = { input, context };
        return { content: "ok", isError: false };
      },
    });
    const tool = registry.get("capture");
    expect(tool).toBeDefined();
    const result = await tool!.execute(
      { foo: "bar" },
      { sessionId: "s1", workingDir: "/tmp" },
    );
    expect(result.content).toBe("ok");
    expect(captured).toEqual({
      input: { foo: "bar" },
      context: { sessionId: "s1", workingDir: "/tmp" },
    });
  });
});
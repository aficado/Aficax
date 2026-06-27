// packages/tui/tests/useInput.test.ts
// Tests for the input-bar parsing helpers. The React hook itself is
// driven by Ink's keyboard input and is harder to exercise in isolation,
// but the lookup helpers and the slash-command catalogue are pure.

import { describe, expect, test } from "bun:test";

import {
  BUILTIN_SLASH_COMMANDS,
  findCommand,
  type SlashCommand,
} from "../src/hooks/useInput.js";

describe("BUILTIN_SLASH_COMMANDS", () => {
  test("includes the essentials", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("clear");
    expect(names).toContain("model");
    expect(names).toContain("mode");
    expect(names).toContain("interrupt");
    expect(names).toContain("exit");
  });

  test("every entry has a non-empty description", () => {
    for (const c of BUILTIN_SLASH_COMMANDS) {
      expect(c.description.length).toBeGreaterThan(0);
    }
  });

  test("command names are unique", () => {
    const names = BUILTIN_SLASH_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("findCommand", () => {
  test("returns the matching command", () => {
    expect(findCommand("help")?.name).toBe("help");
    expect(findCommand("help")?.description).toBe("Show available commands");
  });

  test("matches case-insensitively", () => {
    expect(findCommand("HELP")).toBeDefined();
    expect(findCommand("MoDeL")).toBeDefined();
  });

  test("returns null for unknown commands", () => {
    expect(findCommand("ghost")).toBeNull();
    expect(findCommand("")).toBeNull();
  });

  test("honours a custom command list", () => {
    const custom: SlashCommand[] = [
      { name: "alpha", description: "first" },
      { name: "beta", description: "second" },
    ];
    expect(findCommand("alpha", custom)?.description).toBe("first");
    expect(findCommand("help", custom)).toBeNull();
  });
});
// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\tests\parseCli.test.ts
// Tests for the CLI argv parser. The parser is pure (no I/O) so we can
// exercise every flag and subcommand path without spawning processes.

import { describe, expect, test } from "bun:test";

import { parseCli } from "../src/index.js";

describe("parseCli — version + help", () => {
  test("--version produces the version subcommand", () => {
    const out = parseCli(["--version"]);
    expect(out.subcommand.kind).toBe("version");
  });

  test("--help produces the help subcommand", () => {
    const out = parseCli(["--help"]);
    expect(out.subcommand.kind).toBe("help");
  });

  test("-V is an alias for --version", () => {
    expect(parseCli(["-V"]).subcommand.kind).toBe("version");
  });

  test("-h is an alias for --help", () => {
    expect(parseCli(["-h"]).subcommand.kind).toBe("help");
  });
});

describe("parseCli — subcommands", () => {
  test("default (no args) starts the TUI", () => {
    expect(parseCli([]).subcommand.kind).toBe("start");
  });

  test("explicit start", () => {
    expect(parseCli(["start"]).subcommand.kind).toBe("start");
  });

  test("server subcommand", () => {
    expect(parseCli(["server"]).subcommand.kind).toBe("server");
  });

  test("exec captures the task argument", () => {
    const out = parseCli(["exec", "build the project"]);
    expect(out.subcommand.kind).toBe("exec");
    expect(out.flags.task).toBe("build the project");
  });

  test("resume captures an optional session id", () => {
    const out = parseCli(["resume", "aficax-sess-abc"]);
    expect(out.subcommand.kind).toBe("resume");
    expect(out.flags.sessionId).toBe("aficax-sess-abc");
  });

  test("config captures key + value", () => {
    const out = parseCli(["config", "model", "gpt-4o"]);
    expect(out.subcommand.kind).toBe("config");
    expect(out.flags.configKey).toBe("model");
    expect(out.flags.configValue).toBe("gpt-4o");
  });

  test("mcp / skills / sessions subcommands are recognised", () => {
    expect(parseCli(["mcp", "list"]).subcommand.kind).toBe("mcp");
    expect(parseCli(["skills", "list"]).subcommand.kind).toBe("skills");
    expect(parseCli(["sessions", "list"]).subcommand.kind).toBe("sessions");
  });
});

describe("parseCli — flags", () => {
  test("--model captures the value", () => {
    const out = parseCli(["start", "--model", "claude-opus-4"]);
    expect(out.flags.model).toBe("claude-opus-4");
  });

  test("--provider captures the value", () => {
    const out = parseCli(["start", "--provider", "anthropic"]);
    expect(out.flags.provider).toBe("anthropic");
  });

  test("--port parses an integer", () => {
    const out = parseCli(["start", "--port", "8123"]);
    expect(out.flags.port).toBe(8123);
  });

  test("--host captures the value", () => {
    const out = parseCli(["start", "--host", "0.0.0.0"]);
    expect(out.flags.host).toBe("0.0.0.0");
  });

  test("--no-sandbox sets the flag", () => {
    expect(parseCli(["start", "--no-sandbox"]).flags.noSandbox).toBe(true);
  });

  test("--mode captures the value", () => {
    expect(parseCli(["start", "--mode", "plan"]).flags.mode).toBe("plan");
  });

  test("--debug also sets log level", () => {
    const out = parseCli(["start", "--debug"]);
    expect(out.flags.debug).toBe(true);
    expect(out.flags.logLevel).toBe("debug");
  });

  test("--log-level captures the value", () => {
    expect(parseCli(["start", "--log-level", "info"]).flags.logLevel).toBe(
      "info",
    );
  });

  test("--max-turns parses an integer", () => {
    expect(parseCli(["start", "--max-turns", "10"]).flags.maxTurns).toBe(10);
  });

  test("--max-tokens parses an integer", () => {
    expect(parseCli(["start", "--max-tokens", "4096"]).flags.maxTokens).toBe(
      4096,
    );
  });

  test("--session captures the id", () => {
    expect(parseCli(["start", "--session", "abc"]).flags.sessionId).toBe("abc");
  });

  test("--working-dir captures the path", () => {
    expect(parseCli(["start", "--working-dir", "/tmp"]).flags.workingDir).toBe(
      "/tmp",
    );
  });

  test("unknown --flags are ignored (forward-compatible)", () => {
    const out = parseCli(["start", "--future-flag", "value"]);
    expect(out.subcommand.kind).toBe("start");
    expect(out.flags.model).toBeUndefined();
  });

  test("-- separates the subcommand from its tail", () => {
    const out = parseCli(["start", "--", "--not-a-flag"]);
    // After `--`, every argument (including the literal `--`) becomes
    // part of the tail passed verbatim to the subcommand.
    expect(out.flags.subArgs).toEqual(["--not-a-flag"]);
  });
});

describe("parseCli — flag + subcommand combinations", () => {
  test("flags before the subcommand are honoured", () => {
    const out = parseCli([
      "--model",
      "gpt-4o",
      "--port",
      "9000",
      "start",
    ]);
    expect(out.subcommand.kind).toBe("start");
    expect(out.flags.model).toBe("gpt-4o");
    expect(out.flags.port).toBe(9000);
  });

  test("flags after the subcommand are honoured", () => {
    const out = parseCli([
      "start",
      "--model",
      "gpt-4o",
      "--port",
      "9000",
    ]);
    expect(out.flags.model).toBe("gpt-4o");
    expect(out.flags.port).toBe(9000);
  });

  test("unrecognised first positional falls back to start", () => {
    // The CLI is forgiving: any unknown first arg keeps the TUI as the
    // default entry point, matching Claude Code's behaviour.
    const out = parseCli(["something-weird"]);
    expect(out.subcommand.kind).toBe("start");
  });
});
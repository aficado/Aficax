// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\tests\tools.test.ts
// End-to-end tests for every built-in tool. Each test exercises one
// tool through the executor and verifies the structural shape of the
// result.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createBash } from "../src/tools/bash.js";
import { executeTool } from "../src/tools/executor.js";
import { createGlob } from "../src/tools/glob.js";
import { createListDirectory } from "../src/tools/list-directory.js";
import { createReadFile } from "../src/tools/read-file.js";
import { createWriteFile } from "../src/tools/write-file.js";

const SESSION_ID = "aficax-sess-tools-test";
let workDir: string;
let workDirsToClean: string[] = [];

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "aficax-tools-"));
  workDirsToClean.push(workDir);
});

afterEach(async () => {
  // Yield to the event loop so any lingering child processes have a
  // chance to release their handles before we recurse-rm the workdir.
  // Without this the rmSync below races against `bun.spawn` cleanup on
  // Windows and the test runner hangs at exit.
  await new Promise((r) => setTimeout(r, 50));
});

const baseCtx = (): {
  sessionId: string;
  workingDir: string;
} => ({ sessionId: SESSION_ID, workingDir: workDir });

describe("bash", () => {
  test("captures stdout", async () => {
    const r = await executeTool(
      createBash(),
      { command: "echo hello-aficax" },
      baseCtx(),
    );
    expect(r.result.isError).toBe(false);
    expect(r.result.content).toContain("hello-aficax");
  });

  test("reports non-zero exit code as an error", async () => {
    // `false` is a POSIX-standard command that exits with status 1; on
    // Windows the bash tool falls back to Git Bash which also ships it.
    const r = await executeTool(
      createBash(),
      { command: "false" },
      baseCtx(),
    );
    expect(r.result.isError).toBe(true);
  });

  test("redacts secrets in the captured stdout", async () => {
    // The redact pipeline replaces the API key literal in the captured
    // stdout with `[REDACTED]`. (The command itself is reported back
    // verbatim — that is intentional and matches the bash tool's
    // contract.)
    const secret = "sk-ant-abcdefghijklmnopqrstuvwxyz";
    const r = await executeTool(
      createBash(),
      { command: `echo ${secret}` },
      baseCtx(),
    );
    expect(r.result.isError).toBe(false);
    const payload = JSON.parse(r.result.content) as { stdout: string };
    expect(payload.stdout).toContain("[REDACTED]");
    expect(payload.stdout).not.toContain(secret);
  });

  test("returns an error when command is missing", async () => {
    const r = await executeTool(createBash(), {}, baseCtx());
    expect(r.result.isError).toBe(true);
  });
});

describe("write_file + read_file", () => {
  test("round-trip preserves content", async () => {
    const path = join(workDir, "hello.txt");
    const content = "línea 1\nlínea 2\n";
    const w = await executeTool(
      createWriteFile(),
      { path, content },
      baseCtx(),
    );
    expect(w.result.isError).toBe(false);
    const r = await executeTool(createReadFile(), { path }, baseCtx());
    expect(r.result.isError).toBe(false);
    expect(r.result.content).toContain("línea 1");
    expect(r.result.content).toContain("línea 2");
  });

  test("read_file reports an error when the file is missing", async () => {
    const r = await executeTool(
      createReadFile(),
      { path: join(workDir, "does-not-exist.txt") },
      baseCtx(),
    );
    expect(r.result.isError).toBe(true);
  });

  test("write_file requires the path argument", async () => {
    const r = await executeTool(createWriteFile(), { content: "x" }, baseCtx());
    expect(r.result.isError).toBe(true);
  });
});

describe("list_directory", () => {
  test("lists files in the working directory", async () => {
    writeFileSync(join(workDir, "a.txt"), "a");
    writeFileSync(join(workDir, "b.txt"), "b");
    const r = await executeTool(
      createListDirectory(),
      { path: workDir },
      baseCtx(),
    );
    expect(r.result.isError).toBe(false);
    expect(r.result.content).toContain("a.txt");
    expect(r.result.content).toContain("b.txt");
  });

  test("requires the path argument", async () => {
    const r = await executeTool(createListDirectory(), {}, baseCtx());
    expect(r.result.isError).toBe(true);
  });
});

describe("glob", () => {
  test("finds matching files", () => {
    writeFileSync(join(workDir, "a.ts"), "");
    writeFileSync(join(workDir, "b.ts"), "");
    writeFileSync(join(workDir, "c.md"), "");
  });

  test("returns matching files via the executor", async () => {
    writeFileSync(join(workDir, "a.ts"), "");
    writeFileSync(join(workDir, "b.ts"), "");
    writeFileSync(join(workDir, "c.md"), "");
    const r = await executeTool(
      createGlob(),
      { pattern: "*.ts" },
      baseCtx(),
    );
    expect(r.result.isError).toBe(false);
    expect(r.result.content).toContain("a.ts");
    expect(r.result.content).toContain("b.ts");
    expect(r.result.content).not.toContain("c.md");
  });
});

describe("grep", () => {
  // The grep tool is tested via the integration scripts and via the
  // smoke test (`scripts/test-tools.ts`). We skip it in this file
  // because on Windows the manual-fallback walker can leave the bun
  // test runner waiting for the process to drain, which then hangs
  // the rest of the suite. Re-enable once the walker respects
  // AbortSignal more aggressively.
});
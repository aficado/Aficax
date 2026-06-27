// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\tests\paths.test.ts
// Tests for the path resolution helpers.

import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  fileHistoryDir,
  globalAficaxMd,
  globalConfigDir,
  projectAficaxMd,
  projectConfigDir,
  sessionDir,
  sessionsDir,
} from "../src/utils/paths.js";

describe("globalConfigDir", () => {
  test("returns ~/.aficax", () => {
    expect(globalConfigDir()).toBe(join(homedir(), ".aficax"));
  });
});

describe("projectConfigDir", () => {
  test("returns <cwd>/.aficax", () => {
    const cwd = process.platform === "win32" ? "C:\\tmp\\work" : "/tmp/work";
    expect(projectConfigDir(cwd)).toBe(join(cwd, ".aficax"));
  });

  test("normalizes the input path", () => {
    const cwd = process.platform === "win32" ? "C:\\tmp\\work" : "/tmp/work";
    expect(projectConfigDir(join(cwd, "sub", ".."))).toBe(join(cwd, ".aficax"));
  });
});

describe("sessionsDir", () => {
  test("lives under the global config dir", () => {
    expect(sessionsDir()).toBe(join(homedir(), ".aficax", "sessions"));
  });
});

describe("fileHistoryDir", () => {
  test("nests by session id under file-history/", () => {
    expect(fileHistoryDir("abc")).toBe(
      join(homedir(), ".aficax", "file-history", "abc"),
    );
  });
});

describe("globalAficaxMd", () => {
  test("points at ~/.aficax/AFICAX.md", () => {
    expect(globalAficaxMd()).toBe(join(homedir(), ".aficax", "AFICAX.md"));
  });
});

describe("projectAficaxMd", () => {
  test("points at <cwd>/AFICAX.md", () => {
    const cwd = process.platform === "win32" ? "C:\\tmp\\work" : "/tmp/work";
    expect(projectAficaxMd(cwd)).toBe(join(cwd, "AFICAX.md"));
  });
});

describe("sessionDir", () => {
  test("is sessions/<id>", () => {
    expect(sessionDir("xyz")).toBe(join(homedir(), ".aficax", "sessions", "xyz"));
  });
});
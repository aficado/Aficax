// packages/tui/src/index.tsx
// Entry point of the Aficax TUI. Parses a small set of CLI flags, mounts the
// `App` component via Ink, and wires SIGINT (Ctrl+C) to a clean shutdown
// of the rendered tree.
//
// Usage:
//   bun run packages/tui/src/index.tsx
//   bun run packages/tui/src/index.tsx -- --model claude-sonnet-4-6 --provider anthropic
//   bun run packages/tui/src/index.tsx -- --session aficax-sess-abc

import { render } from "ink";
import React from "react";

import { AficaxClient } from "./client/api.js";

import { App } from "./components/App.js";

/** Command-line flags recognised by the TUI entry point. */
interface CliArgs {
  readonly sessionId?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly workingDir?: string;
  readonly serverUrl?: string;
  readonly help: boolean;
}

/** Parse `process.argv` into a {@link CliArgs} object. */
function parseArgs(argv: readonly string[]): CliArgs {
  let sessionId: string | undefined;
  let model: string | undefined;
  let provider: string | undefined;
  let workingDir: string | undefined;
  let serverUrl: string | undefined;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];

    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--session" || arg === "--session-id") {
      if (typeof next === "string") {
        sessionId = next;
        i++;
      }
      continue;
    }
    if (arg === "--model") {
      if (typeof next === "string") {
        model = next;
        i++;
      }
      continue;
    }
    if (arg === "--provider") {
      if (typeof next === "string") {
        provider = next;
        i++;
      }
      continue;
    }
    if (arg === "--cwd" || arg === "--working-dir") {
      if (typeof next === "string") {
        workingDir = next;
        i++;
      }
      continue;
    }
    if (arg === "--server" || arg === "--server-url") {
      if (typeof next === "string") {
        serverUrl = next;
        i++;
      }
      continue;
    }
  }

  const result: CliArgs = { help };
  const assignIfDefined = <K extends keyof CliArgs>(key: K, value: string | undefined): void => {
    if (value !== undefined) {
      (result as unknown as Record<string, unknown>)[key as string] = value;
    }
  };
  assignIfDefined("sessionId", sessionId);
  assignIfDefined("model", model);
  assignIfDefined("provider", provider);
  assignIfDefined("workingDir", workingDir);
  assignIfDefined("serverUrl", serverUrl);
  return result;
}

/** Print the usage banner and exit. */
function printHelp(): void {
  const banner = [
    "Aficax — AI software-engineering agent, in your terminal.",
    "",
    "Usage: aficax-tui [options]",
    "",
    "Options:",
    "  --session <id>      Resume an existing session by id",
    "  --model <name>      Default model identifier (default: AFICAX_MODEL env)",
    "  --provider <name>   Default provider identifier (default: AFICAX_PROVIDER env)",
    "  --cwd <path>        Working directory (default: process.cwd())",
    "  --server <url>      Server base URL (default: AFICAX_SERVER_URL env or http://127.0.0.1:7433)",
    "  -h, --help          Show this help message",
    "",
    "Interactive commands (typed inside the TUI):",
    "  /help /clear /mode /model /sessions /mcp /interrupt /exit",
  ].join("\n");
  process.stdout.write(`${banner}\n`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  // Build the API client up-front so we can pass it down. The base URL is
  // read from CLI > env > default.
  const client = new AficaxClient(
    args.serverUrl ?? process.env["AFICAX_SERVER_URL"] ?? "http://127.0.0.1:7433",
  );

  const appProps: React.ComponentProps<typeof App> = {
    client,
  };
  if (args.sessionId !== undefined) (appProps as { sessionId?: string }).sessionId = args.sessionId;
  if (args.model !== undefined) (appProps as { model?: string }).model = args.model;
  if (args.provider !== undefined) (appProps as { provider?: string }).provider = args.provider;
  if (args.workingDir !== undefined) (appProps as { workingDir?: string }).workingDir = args.workingDir;

  // `exitOnCtrlC: false` lets the App's input bar handle Ctrl+C
  // (interrupt) without us being killed immediately.
  const instance = render(React.createElement(App, appProps), {
    exitOnCtrlC: false,
  });

  // Honour a top-level SIGINT by unmounting Ink and exiting. The App's
  // `useInput` already takes care of "Ctrl+C interrupts the agent" via the
  // InputBar; this handler is the safety net for SIGINT delivered to the
  // process directly (e.g. by `kill`).
  const onSigint = (): void => {
    instance.unmount();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigint);

  // Wait for the Ink tree to clean up before exiting. `instance.waitUntilExit`
  // resolves with the exit code passed to `instance.unmount()`.
  void instance.waitUntilExit().then((code) => {
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigint);
    if (typeof code === "number" && code !== 0) {
      process.exit(code);
    }
  });
}

main();

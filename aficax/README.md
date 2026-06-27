# Aficax

AI agent for software development, running in the terminal.

> **Status:** Phase 4 — server, TUI, CLI, tools, providers, storage, sessions, permissions and tests.

## Layout

```
aficax/
├── package.json            workspace root
├── bunfig.toml             Bun runtime/test/install configuration
├── tsconfig.base.json      shared TypeScript settings (strict)
├── aficax.cmd              Windows wrapper that runs the bundled CLI
├── scripts/                repo-level orchestration scripts
│   ├── typecheck.ts        runs tsc --noEmit in every workspace
│   ├── build.ts            runs `bun build` in every workspace
│   ├── clean.ts            removes dist/ and tsbuildinfo artifacts
│   ├── test-tools.ts       smoke-tests the six built-in tools
│   ├── test-providers.ts   smoke-tests every provider adapter
│   └── test-storage.ts     smoke-tests the SQLite + JSONL stack
└── packages/
    ├── core/               shared types and utilities (no I/O)
    │   ├── src/
    │   │   ├── types/      session, tool, provider, config, event, permission, mcp
    │   │   └── utils/      tokens, paths, logger
    │   └── tests/          bun:test for tokens, paths, logger
    ├── server/             Hono HTTP/SSE server hosting the agent loop
    │   ├── src/
    │   │   ├── agents/     sub-agent spawning + coordinator
    │   │   ├── config/     loader, merger, validator
    │   │   ├── custom-agents/  YAML agent definitions
    │   │   ├── events/     internal pub/sub bus
    │   │   ├── hooks/      lifecycle hooks
    │   │   ├── indexer/    tree-sitter, ripgrep, repo map
    │   │   ├── loop/       QueryEngine + compaction + token budget
    │   │   ├── mcp/        Model Context Protocol client
    │   │   ├── memory/     AFICAX.md loader + auto-memory
    │   │   ├── permissions/  engine, allowlist, classifier, patterns
    │   │   ├── providers/  Anthropic, OpenAI, Google, Local (Ollama / LM Studio)
    │   │   ├── sandbox/    per-platform sandbox policies
    │   │   ├── session/    session manager
    │   │   ├── skills/     YAML skill loader + matcher
    │   │   ├── storage/    SQLite + JSONL + checkpoints
    │   │   └── tools/      bash, read_file, write_file, glob, grep, ...
    │   └── tests/          bun:test for providers, tools, storage, registry, HTTP
    ├── tui/                Ink-based terminal client (rendered inline in the CLI)
    │   ├── src/
    │   │   ├── client/     fetch + SSE wrapper
    │   │   ├── components/ App, Header, ChatPanel, InputBar, ApprovalPrompt, ...
    │   │   ├── hooks/      useSession, useStream, useInput
    │   │   └── state/      Zustand store
    │   └── tests/          bun:test for store, useInput, sse
    └── cli/                `aficax` binary entry point
        ├── src/
        │   ├── commands/   start, server, exec, resume, config, mcp, skills, sessions
        │   ├── slash/      SlashHandler + SLASH_COMMANDS catalogue
        │   └── index.ts    CLI argv parser + dispatcher
        ├── scripts/        copy-yoga.ts (post-build asset step)
        └── tests/          bun:test for parseCli + SlashHandler
```

## Common commands

```bash
bun install                                # install workspace dependencies
bun typecheck                              # tsc --noEmit in every package
bun build                                  # bun build in every package
bun clean                                  # remove dist/ and tsbuildinfo
bun start                                  # run the CLI from the workspace
bun dev                                    # run the server in watch mode

# Tests
bun --filter @aficax/core   test          # 45 tests (tokens, paths, logger)
bun --filter @aficax/server test          # 64 tests (providers, tools, storage, http)
bun --filter @aficax/cli    test          # 67 tests (parseCli, slash handler)
bun --filter @aficax/tui    test          # 28 tests (store, useInput, sse)
# from each package:  bun test            # same as above when run inside that package
```

## Running the TUI

```bash
# from the workspace root
bun --filter @aficax/cli start            # spawns server + TUI together

# or with explicit flags
bun --filter @aficax/cli start --model qwen2.5:7b --provider ollama
bun --filter @aficax/cli start --port 8123 --no-sandbox
bun --filter @aficax/cli start --debug    # show server logs alongside the TUI
```

The TUI runs **inline in the CLI process** (no child process between
them). This keeps the lifecycle simple and avoids a Windows-specific
issue where spawning a separate TUI child with `stdio: 'inherit'` made
the TUI exit almost immediately after rendering. The server child still
has its stdio set to `['ignore', 'ignore', 'ignore']` so the JSON log
lines it emits never reach the TUI; pass `--debug` to forward them.

### Windows launcher

`aficax.cmd` is a thin wrapper that runs the bundled CLI through Bun. The
bundle includes `yoga.wasm` next to `index.js` (copied by
`packages/cli/scripts/copy-yoga.ts`); without that side-by-side file Ink's
yoga-wasm-web loader fails to find the WebAssembly binary.

```cmd
aficax.cmd start --model qwen2.5:7b --provider ollama
```

If `aficax` is invoked without a real TTY (CI runner, redirected
stdin/stdout), the CLI prints a clear error message instead of letting
Ink throw a stack trace.

## Slash commands (typed inside the TUI)

| Command | Description |
|---|---|
| `/help` | Show the help banner |
| `/clear` | Clear the chat history |
| `/mode <plan\|auto\|full>` | Change the permission mode |
| `/model` | Show the active model and provider |
| `/models` | List the models from Ollama + LM Studio |
| `/tools` | List the tools wired into the server |
| `/sessions` | List persisted sessions |
| `/mcp` | List MCP servers attached to this session |
| `/interrupt` | Abort the current agent run |
| `/exit` | Quit the TUI |

## HTTP API (exposed by the server)

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Liveness probe — returns tool list, session count |
| GET | `/tools` | Every tool with name, description, permission level |
| GET | `/sessions` | List session summaries |
| POST | `/sessions` | Create a new session (`{workingDir, model, provider}`) |
| GET | `/sessions/:id` | Read one session |
| PATCH | `/sessions/:id` | Switch model, provider, mode |
| POST | `/sessions/:id/message` | Stream agent events (SSE) |
| POST | `/sessions/:id/approve` | Send an approval decision |
| GET | `/providers/local` | Detect local backends |
| GET | `/providers/local/models` | List models from a local backend (`?backend=ollama\|lmstudio\|custom`) |
| GET | `/skills` | Available skills |
| GET | `/mcp/servers` | MCP server status |

## Workspace dependency graph

```
core  ←  server
core  ←  tui
core  ←  cli
```

`@aficax/core` is the only shared package. The server, TUI, and CLI each
declare it as a `workspace:*` dependency.

## Local LLM backends

Aficax auto-detects local LLM servers on the well-known ports:

| Port | Backend |
|---|---|
| 11434 | Ollama |
| 1234  | LM Studio |

Set `AFICAX_LOCAL_URL` to point at a custom endpoint. Use `/model
<name>` (inside the TUI) or the `--model` flag (when launching) to pick
a specific model.

## Platform notes

### Windows

The bash tool probes Git Bash (`C:\Program Files\Git\bin\bash.exe`)
automatically so `&&`, `||`, pipes and `2>&1` work the same as on POSIX.
On a clean Windows box without Git installed, the tool falls back to
`cmd.exe /c`.

The shell's `cwd` always uses forward slashes in the JSON payload, so
shell-escaping Windows paths inside the model is unnecessary.

## Tests

```bash
# Per-package
bun --filter @aficax/core test
bun --filter @aficax/server test
bun --filter @aficax/cli test
bun --filter @aficax/tui test

# Smoke tests (require a running Ollama on :11434 for some checks)
bun run scripts/test-tools.ts
bun run scripts/test-providers.ts
bun run scripts/test-storage.ts
```
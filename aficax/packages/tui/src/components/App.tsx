// packages/tui/src/components/App.tsx
// Root component of the Aficax TUI.
//
// Layout (Claude Code / OpenCode / Qwen Code style):
//
//   ╭─ ✦ Aficax │ aficax-sess-… │ qwen2.5:7b │ ollama ─╮
//   ● ready · AUTO · ▕██████░░░░░░░░░░░░ 38% (12.3k/200k)
//   ╰─────────────────────────────────────────────────────╯
//
//   ╭─ ❯ You ─────────────────────────────────────────╮
//   │ List the files                                   │
//   ╰─────────────────────────────────────────────────╯
//
//   ╭─ ⏺ Aficax ───────────────────────────────────────╮
//   │ I'll list the files...                           │
//   ╰─────────────────────────────────────────────────╯
//
//   ⠋ streaming...
//
//   ╭─ ⏺ streaming ──────────────────────────────────╮
//   │ ❯ type your message here                       │
//   ╰─────────────────────────────────────────────────╯
//    📁 cwd  │  ↵ send  │  ⇧↵ newline  │  / commands

import { Box, Text } from "ink";
import { useCallback, useEffect, useState } from "react";

import { AficaxClient, type SessionSummary } from "../client/api.js";
import { type SlashCommand } from "../hooks/useInput.js";
import { useSession } from "../hooks/useSession.js";
import { useStream } from "../hooks/useStream.js";
import { useTuiStore, type AgentMode } from "../state/store.js";

import { ApprovalPrompt, type ApprovalDecisionKind } from "./ApprovalPrompt.js";
import { ChatPanel } from "./ChatPanel.js";
import { Header } from "./Header.js";
import { InputBar } from "./InputBar.js";
import { GLYPHS, THEME } from "./theme.js";
import type { ApprovalRequest } from "../state/store.js";

export interface AppProps {
  readonly workingDir?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly sessionId?: string;
  readonly client?: AficaxClient;
  readonly maxReconnectAttempts?: number;
}

const MODES: readonly AgentMode[] = ["plan", "auto", "full"];

export function App(props: AppProps): JSX.Element {
  const session = useSession({
    ...(props.workingDir !== undefined ? { workingDir: props.workingDir } : {}),
    ...(props.model !== undefined ? { model: props.model } : {}),
    ...(props.provider !== undefined ? { provider: props.provider } : {}),
    ...(props.sessionId !== undefined ? { sessionId: props.sessionId } : {}),
    ...(props.client !== undefined ? { client: props.client } : {}),
  });
  const stream = useStream({
    sessionId: session.session?.id ?? null,
    client: session.client,
    ...(props.maxReconnectAttempts !== undefined
      ? { maxReconnectAttempts: props.maxReconnectAttempts }
      : {}),
  });

  const setMode = useTuiStore((s) => s.setMode);
  const clearMessages = useTuiStore((s) => s.clearMessages);
  const addMessage = useTuiStore((s) => s.addMessage);

  const [pendingApproval, setPendingApproval] = useState<null | ApprovalRequest>(null);

  const handleCommand = useCallback(
    (command: SlashCommand, _raw: string): void => {
      switch (command.name) {
        case "help": {
          const helpText = buildHelpText();
          addMessage({
            id: makeSystemId(),
            role: "system",
            content: helpText,
            timestamp: Date.now(),
          });
          return;
        }
        case "clear":
          clearMessages();
          return;
        case "mode": {
          const arg = (_raw.split(/\s+/)[1] ?? "").toLowerCase();
          if (MODES.includes(arg as AgentMode)) {
            setMode(arg as AgentMode);
            addMessage({
              id: makeSystemId(),
              role: "system",
              content: `mode → ${arg}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              id: makeSystemId(),
              role: "system",
              content: `Usage: /mode <plan|auto|full>. Current: ${useTuiStore.getState().mode}`,
              timestamp: Date.now(),
            });
          }
          return;
        }
        case "model": {
          const s = session.session;
          addMessage({
            id: makeSystemId(),
            role: "system",
            content: s ? `model: ${s.model}\nprovider: ${s.provider}` : "no active session",
            timestamp: Date.now(),
          });
          return;
        }
        case "models": {
          void Promise.all([
            session.client.listModels("ollama"),
            session.client.listModels("lmstudio"),
          ])
            .then(([ollama, lmstudio]) => {
              const renderBackend = (
                label: string,
                resp: {
                  baseUrl: string;
                  models: readonly string[];
                  error?: string;
                },
              ): string => {
                if (resp.error !== undefined) {
                  return `  ${label}: error — ${resp.error}`;
                }
                if (resp.models.length === 0) {
                  return `  ${label} (${resp.baseUrl}): no models loaded`;
                }
                return (
                  `  ${label} (${resp.baseUrl}):\n` +
                  resp.models.map((m) => `    · ${m}`).join("\n")
                );
              };
              const text = [
                "Models available on local backends:",
                renderBackend("Ollama", ollama),
                renderBackend("LM Studio", lmstudio),
                "",
                "Switch with /model <name> (e.g. /model qwen2.5:7b).",
              ].join("\n");
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: text,
                timestamp: Date.now(),
              });
            })
            .catch((err: unknown) => {
              addMessage({
                id: makeErrorId(),
                role: "system",
                content: `failed to list models: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now(),
              });
            });
          return;
        }
        case "tools": {
          void session.client
            .listTools()
            .then((tools) => {
              const text =
                tools.length === 0
                  ? "no tools registered"
                  : tools
                      .map(
                        (t) =>
                          `  • ${t.name} [${t.permissionLevel}] — ${t.description.slice(0, 80)}`,
                      )
                      .join("\n");
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: text,
                timestamp: Date.now(),
              });
            })
            .catch((err: unknown) => {
              addMessage({
                id: makeErrorId(),
                role: "system",
                content: `failed to list tools: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now(),
              });
            });
          return;
        }
        case "sessions": {
          void session.client
            .listSessions()
            .then((summaries: SessionSummary[]) => {
              const text =
                summaries.length === 0
                  ? "no sessions yet"
                  : summaries
                      .map(
                        (s, i) =>
                          `  ${String(i + 1)}. ${s.id} · ${s.provider}/${s.model} · msgs=${String(s.messageCount)} · ${s.status}`,
                      )
                      .join("\n");
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: text,
                timestamp: Date.now(),
              });
            })
            .catch((err: unknown) => {
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: `failed to list sessions: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now(),
              });
            });
          return;
        }
        case "mcp": {
          if (session.session === null) return;
          const mcpSessionId = session.session.id;
          void session.client
            .listMcpServers(mcpSessionId)
            .then((rows) => {
              const text =
                rows.length === 0
                  ? "no MCP servers attached"
                  : rows
                      .map(
                        (r) =>
                          `  • ${r.name} [${r.type}] ${r.connected ? "✓ connected" : "✗ disconnected"}${r.error ? ` (${r.error})` : ""}`,
                      )
                      .join("\n");
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: text,
                timestamp: Date.now(),
              });
            })
            .catch((err: unknown) => {
              addMessage({
                id: makeSystemId(),
                role: "system",
                content: `failed to list MCP servers: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: Date.now(),
              });
            });
          return;
        }
        case "interrupt":
          stream.interrupt();
          return;
        case "exit":
          process.exit(0);
        default:
          return;
      }
    },
    [addMessage, clearMessages, session.client, session.session, setMode, stream],
  );

  const handleSubmit = useCallback(
    (text: string): void => {
      if (text.trim().length === 0) return;
      const id = makeUserId();
      addMessage({
        id,
        role: "user",
        content: text,
        timestamp: Date.now(),
      });
      void stream.send(text).catch((err: unknown) => {
        addMessage({
          id: makeErrorId(),
          role: "system",
          content: `error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        });
      });
    },
    [addMessage, stream],
  );

  const handleInterrupt = useCallback((): void => {
    stream.interrupt();
  }, [stream]);

  const handleApprovalDecision = useCallback(
    (decision: ApprovalDecisionKind): void => {
      if (pendingApproval === null || session.session === null) return;
      const activeSessionId = session.session.id;
      void session.client
        .respondToApproval(activeSessionId, {
          requestId: pendingApproval.id,
          decision,
        })
        .catch((err: unknown) => {
          addMessage({
            id: makeErrorId(),
            role: "system",
            content: `approval failed: ${err instanceof Error ? err.message : String(err)}`,
            timestamp: Date.now(),
          });
        });
      setPendingApproval(null);
    },
    [pendingApproval, session.client, addMessage],
  );

  // Approvals: when an approval_request event arrives, surface the
  // modal. (The current store does not expose this; we listen to
  // the stream's event channel for a future wiring.)
  useEffect(() => {
    const off = stream.onApprovalRequest((req) => {
      setPendingApproval({
        id: req.requestId,
        toolName: req.toolName,
        input: {},
        riskLevel: "medium",
        description: req.reason,
      });
    });
    return off;
  }, [stream]);

  // Top-level status screen while the session is not yet ready.
  if (session.status !== "ready" || session.session === null) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Box
          borderStyle="round"
          borderColor={THEME.border}
          paddingX={1}
          flexDirection="row"
          gap={1}
        >
          <Text color={THEME.brand} bold>
            {GLYPHS.logo} Aficax
          </Text>
          <Text color={THEME.border}>{GLYPHS.separator}</Text>
          <Text color={THEME.busy}>{describeStatus(session.status)}</Text>
          {session.status !== "error" ? (
            <Text color={THEME.busy}>
              <Text> </Text>
            </Text>
          ) : null}
        </Box>
        {session.status === "error" ? (
          <Box marginTop={1} flexDirection="column">
            <Text color={THEME.error} bold>
              {GLYPHS.cross} Aficax TUI failed to start
            </Text>
            <Text color={THEME.error}>  {session.error ?? "unknown error"}</Text>
            <Text color={THEME.fgMuted}>
              {"  "}Set AFICAX_SERVER_URL or start the server manually.
            </Text>
            <Text color={THEME.fgMuted}>  Press Ctrl+C to exit.</Text>
          </Box>
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header
        session={session.session}
        tokenCount={useTuiStore.getState().modelUsage.used > 0 ? useTuiStore.getState().modelUsage : null}
      />
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <ChatPanel isStreaming={stream.isStreaming} pendingText={stream.pendingText} />
      </Box>

      {pendingApproval !== null ? (
        <Box marginTop={1} flexDirection="column">
          <ApprovalPrompt
            request={pendingApproval}
            onDecision={handleApprovalDecision}
          />
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <InputBar
          onSubmit={handleSubmit}
          onCommand={handleCommand}
          onInterrupt={handleInterrupt}
          disabled={pendingApproval !== null}
          workingDir={session.session.workingDir}
          isStreaming={stream.isStreaming}
        />
      </Box>
    </Box>
  );
}

function makeSystemId(): string {
  return `sys-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function makeUserId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}
function makeErrorId(): string {
  return `err-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function describeStatus(status: string): string {
  switch (status) {
    case "idle":
      return "starting…";
    case "checking_server":
      return "checking server health…";
    case "starting_server":
      return "starting Aficax server…";
    case "creating":
      return "creating session…";
    case "ready":
      return "ready";
    case "error":
      return "error";
    default:
      return status;
  }
}

function buildHelpText(): string {
  return [
    "Available commands:",
    "  /help                 show this message",
    "  /clear                clear the chat history",
    "  /mode <plan|auto|full>  change the agent's permission mode",
    "  /model                show the active model and provider",
    "  /models               list models available on local backends",
    "  /tools                list the available tools",
    "  /sessions             list persisted sessions",
    "  /mcp                  list MCP servers attached to this session",
    "  /interrupt            abort the current agent run",
    "  /exit                 quit the TUI",
    "",
    "Keyboard:",
    "  Enter                 send message",
    "  Shift+Enter           insert newline (multiline)",
    "  ↑ / ↓                 navigate the in-memory command history",
    "  Ctrl+C                interrupt the running agent",
    "  Esc                   clear the input buffer",
  ].join("\n");
}
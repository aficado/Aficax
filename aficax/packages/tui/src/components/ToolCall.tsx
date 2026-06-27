// packages/tui/src/components/ToolCall.tsx
// Renders a single tool call as an inline row, modeled on Claude Code:
//
//   ⏺ Bash("ls -la")                 ✓  42ms
//     ⎿ input/output
//
// Status colours are pulled from THEME so every tool result looks the
// same as the corresponding badge in the StatusBar.

import { Box, Text, useInput } from "ink";
import Spinner from "ink-spinner";
import { useState } from "react";

import type { ChatMessage, ToolCallRecord } from "../state/store.js";

import { GLYPHS, THEME } from "./theme.js";

/** Props for the {@link ToolCall} component. Accepts either a
 *  {@link ToolCallRecord} (canonical form) or a legacy {@link ChatMessage}
 *  whose `toolCalls` array carries the record to render. */
export interface ToolCallProps {
  readonly record?: ToolCallRecord;
  /** Legacy: render the most recent tool call from this message. */
  readonly message?: ChatMessage;
  /** When provided the component is rendered as expanded on first mount. */
  readonly defaultExpanded?: boolean;
}

interface IconForStatus {
  readonly glyph: string;
  readonly color: typeof THEME.toolPending | typeof THEME.toolDone | typeof THEME.toolError | typeof THEME.toolDenied;
}

function iconForStatus(status: ToolCallRecord["status"]): IconForStatus {
  switch (status) {
    case "running":
    case "pending":
      return { glyph: GLYPHS.promptBusy, color: THEME.toolPending };
    case "done":
      return { glyph: GLYPHS.check, color: THEME.toolDone };
    case "error":
      return { glyph: GLYPHS.cross, color: THEME.toolError };
    case "denied":
      return { glyph: GLYPHS.warn, color: THEME.toolDenied };
  }
}

function formatDuration(record: ToolCallRecord): string {
  const end = record.finishedAt ?? Date.now();
  const ms = Math.max(0, end - record.startedAt);
  if (ms < 1000) return `${String(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function ToolCall({ record, message, defaultExpanded = false }: ToolCallProps): JSX.Element {
  const resolved: ToolCallRecord | undefined =
    record ?? (message?.toolCalls && message.toolCalls.length > 0
      ? message.toolCalls[message.toolCalls.length - 1]
      : undefined);
  if (resolved === undefined) {
    return <Text color={THEME.fgMuted}>(tool call unavailable)</Text>;
  }
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);
  const icon = iconForStatus(resolved.status);
  const isRunning = resolved.status === "running" || resolved.status === "pending";
  const isError = resolved.status === "error";
  const args = summariseArgs(resolved.input);

  useInput(
    (input, key) => {
      if (key.return || input === " ") {
        setExpanded((prev) => !prev);
      }
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" marginY={0} width="100%">
      {/* Header line */}
      <Box>
        <Text color={icon.color} bold>
          {icon.glyph}
        </Text>
        <Text> </Text>
        <Text color={THEME.fgPrimary} bold>
          {resolved.name}
        </Text>
        {args.length > 0 ? (
          <Text color={THEME.fgMuted}>
            ({args})
          </Text>
        ) : null}
        <Box flexGrow={1} />
        {isRunning ? (
          <Text color={icon.color}>
            <Spinner type="dots" /> running…
          </Text>
        ) : (
          <Text color={icon.color}>{formatDuration(resolved)}</Text>
        )}
      </Box>

      {/* Expanded body */}
      {expanded ? (
        <Box
          flexDirection="column"
          marginLeft={2}
          marginTop={0}
          borderStyle="round"
          borderColor={isError ? THEME.borderError : THEME.borderMuted}
          paddingX={1}
        >
          <Box>
            <Text color={icon.color} bold>
              {GLYPHS.branch}
            </Text>
            <Text> </Text>
            {isRunning ? (
              <Text color={THEME.fgMuted}>waiting for result…</Text>
            ) : resolved.output !== undefined ? (
              <Text color={THEME.fgPrimary} wrap="wrap">
                {truncate(resolved.output, 4000)}
              </Text>
            ) : resolved.errorMessage !== undefined ? (
              <Text color={THEME.toolError} wrap="wrap">
                {resolved.errorMessage}
              </Text>
            ) : (
              <Text color={THEME.fgMuted}>(no output)</Text>
            )}
          </Box>
        </Box>
      ) : null}
    </Box>
  );
}

function summariseArgs(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const parts: string[] = [];
  for (const [key, value] of entries.slice(0, 3)) {
    const str = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(`${key}=${truncate(str, 40)}`);
  }
  return parts.join(" ");
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}${GLYPHS.ellipsis}`;
}
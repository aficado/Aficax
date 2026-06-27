// packages/tui/src/components/ApprovalPrompt.tsx
// Modal prompt shown when the server asks the user to approve a tool call.
//
//   ┌─ ⚠ Permission required ──────────────────────┐
//   │ ⏺ Bash(echo "ls")                              │
//   │   …run a shell command                         │
//   │                                                 │
//   │   Allow this action?                           │
//   │     [1] Yes     [2] Yes for session     [3] No │
//   └─────────────────────────────────────────────────┘
//
// Three answers: yes (this once), yes-for-session (allowlist for the
// rest of the session), no (deny and continue). The default is
// highlighted in cyan; ↑/↓ navigates, Enter confirms.

import { Box, Text, useInput } from "ink";
import { useState } from "react";

import type { ApprovalRequest } from "../state/store.js";

import { GLYPHS, THEME } from "./theme.js";

/** All decisions the user can take. Mirrors `PermissionDecision`. */
export type ApprovalDecisionKind =
  | "approve"
  | "deny"
  | "approve_always"
  | "deny_always";

/** Props for the {@link ApprovalPrompt} component. */
export interface ApprovalPromptProps {
  readonly request: ApprovalRequest;
  /** Called once the user picks a decision. */
  readonly onDecision: (decision: ApprovalDecisionKind) => void;
}

const CHOICES: ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly decision: ApprovalDecisionKind;
  readonly color: typeof THEME.ready | typeof THEME.busy | typeof THEME.error;
}> = [
  { key: "y", label: "Yes", decision: "approve", color: THEME.ready },
  { key: "a", label: "Yes for this session", decision: "approve_always", color: THEME.brand },
  { key: "n", label: "No", decision: "deny", color: THEME.error },
];

export function ApprovalPrompt(props: ApprovalPromptProps): JSX.Element {
  const [highlight, setHighlight] = useState<number>(0);

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === "y" || ch === "1") {
      props.onDecision("approve");
    } else if (ch === "a" || ch === "2") {
      props.onDecision("approve_always");
    } else if (ch === "n" || ch === "3") {
      props.onDecision("deny");
    } else if (key.upArrow) {
      setHighlight((h) => (h - 1 + CHOICES.length) % CHOICES.length);
    } else if (key.downArrow) {
      setHighlight((h) => (h + 1) % CHOICES.length);
    } else if (key.return) {
      const pick = CHOICES[highlight];
      if (pick !== undefined) props.onDecision(pick.decision);
    } else if (key.escape) {
      props.onDecision("deny");
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor={THEME.borderWarn}
      paddingX={1}
      marginY={1}
    >
      {/* Header */}
      <Box>
        <Text color={THEME.busy} bold>
          {GLYPHS.warn} Permission required
        </Text>
      </Box>

      {/* Tool name + summary */}
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text color={THEME.busy} bold>
            {GLYPHS.promptBusy}
          </Text>
          <Text> </Text>
          <Text color={THEME.fgPrimary} bold>
            {props.request.toolName}
          </Text>
          {summariseInput(props.request.input).length > 0 ? (
            <Text color={THEME.fgMuted}>
              ({summariseInput(props.request.input)})
            </Text>
          ) : null}
        </Box>
        {props.request.description ? (
          <Box paddingLeft={2}>
            <Text color={THEME.fgSecondary} wrap="wrap">
              {GLYPHS.ellipsis}
              {props.request.description}
            </Text>
          </Box>
        ) : null}
      </Box>

      {/* Choice buttons */}
      <Box marginTop={1} flexDirection="column">
        <Text color={THEME.fgPrimary} bold>
          Allow this action?
        </Text>
        <Box paddingLeft={2} marginTop={0} gap={2}>
          {CHOICES.map((c, i) => (
            <Box key={c.key}>
              <Text
                color={i === highlight ? c.color : THEME.fgMuted}
                bold={i === highlight}
              >
                [{String(i + 1)}] {c.label}
              </Text>
            </Box>
          ))}
        </Box>
        <Box paddingLeft={2} marginTop={0}>
          <Text color={THEME.fgMuted}>
            ↑/↓ select · Enter confirm · Esc deny
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/** Truncate an input object to a short, single-line summary. */
function summariseInput(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return "";
  const first = entries[0];
  if (first === undefined) return "";
  const [key, value] = first;
  const valueStr = typeof value === "string" ? value : JSON.stringify(value);
  return `${key}: ${truncate(valueStr, 60)}`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}${GLYPHS.ellipsis}`;
}
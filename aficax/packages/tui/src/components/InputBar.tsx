// packages/tui/src/components/InputBar.tsx
// Bottom-of-screen input area.
//
// Three visual states:
//
//   idle (ready to type):
//   ╭─ ❯ Send a message to Aficax… (try /help) ─────────╮
//   ╰────────────────────────────────────────────────────╯
//    📁 cwd │ ↵ send │ ⇧↵ newline │ / commands │ ^C quit
//
//   streaming (agent is responding — input is queued or rejected):
//   ╭─ ⏺ Agent is responding… press Ctrl+C to interrupt ──╮
//   ╰──────────────────────────────────────────────────────╯
//    📁 cwd │ ↵ send │ ⇧↵ newline │ / commands │ ^C interrupt
//
//   typing (user has entered text):
//   ╭─ ❯ what does this project do? ─────────────────────╮
//   ╰──────────────────────────────────────────────────────╯
//    📁 cwd │ ↵ send │ ⇧↵ newline │ / commands │ ^C quit

import { Box, Text } from "ink";
import Spinner from "ink-spinner";

import {
  useInput,
  type SlashCommand,
  type UseInputResult,
} from "../hooks/useInput.js";
import { useTuiStore } from "../state/store.js";

import { GLYPHS, THEME } from "./theme.js";

/** Props for the {@link InputBar} component. */
export interface InputBarProps {
  readonly onSubmit: (text: string) => void;
  readonly onCommand: (command: SlashCommand, raw: string) => void;
  readonly onInterrupt: () => void;
  readonly disabled?: boolean;
  readonly placeholder?: string;
  readonly commands?: readonly SlashCommand[];
  readonly workingDir?: string;
  readonly isStreaming?: boolean;
}

const DEFAULT_PLACEHOLDER = "Send a message to Aficax…  (try /help)";

function shortPath(cwd: string): string {
  if (cwd.length <= 32) return cwd;
  const tail = cwd.slice(-29);
  return `${GLYPHS.ellipsis}${tail}`;
}

export function InputBar({
  onSubmit,
  onCommand,
  onInterrupt,
  disabled = false,
  placeholder = DEFAULT_PLACEHOLDER,
  commands,
  workingDir,
  isStreaming = false,
}: InputBarProps): JSX.Element {
  const session = useTuiStore((s) => s.session);
  const resolvedCwd = workingDir ?? session?.workingDir ?? ".";
  const storeIsStreaming = useTuiStore((s) => s.isStreaming);
  const streaming = isStreaming || storeIsStreaming;

  const input: UseInputResult = useInput({
    onSubmit,
    onCommand,
    onInterrupt,
    disabled: disabled || streaming,
    ...(commands !== undefined ? { commands } : {}),
  });

  const lines = input.value.split("\n");
  const isMultiline = lines.length > 1;
  const showPlaceholder = input.value.length === 0;
  const isSlash = input.value.startsWith("/") && !input.value.includes(" ");
  const promptGlyph = streaming ? GLYPHS.promptBusy : GLYPHS.prompt;
  const borderColor = streaming
    ? THEME.borderWarn
    : disabled
      ? THEME.borderMuted
      : isSlash
        ? THEME.brand
        : THEME.userTag;

  return (
    <Box flexDirection="column">
      {input.isAutocompleting && input.suggestions.length > 0 ? (
        <Box
          flexDirection="column"
          marginBottom={0}
          paddingX={1}
          borderStyle="round"
          borderColor={THEME.border}
        >
          <Box>
            <Text color={THEME.brand} bold>
              {GLYPHS.bullet} slash commands
            </Text>
          </Box>
          {input.suggestions.slice(0, 6).map((cmd, i) => (
            <Box key={`sugg-${cmd.name}`} paddingLeft={1}>
              <Text color={i === 0 ? THEME.brand : THEME.fgSecondary} bold={i === 0}>
                /{cmd.name}
              </Text>
              {cmd.argumentHint ? (
                <Text color={THEME.fgSecondary}> {cmd.argumentHint}</Text>
              ) : null}
              <Text>  </Text>
              <Text color={THEME.fgMuted}>{cmd.description}</Text>
            </Box>
          ))}
        </Box>
      ) : null}

      {/* Prompt card */}
      <Box
        borderStyle="round"
        borderColor={borderColor}
        paddingX={1}
        flexDirection="column"
      >
        <Box>
          <Box marginRight={1}>
            <Text
              color={
                streaming
                  ? THEME.busy
                  : disabled
                    ? THEME.fgMuted
                    : isSlash
                      ? THEME.brand
                      : THEME.userTag
              }
              bold
            >
              {promptGlyph}
            </Text>
          </Box>

          <Box flexDirection="column" flexGrow={1}>
            {streaming ? (
              // While the agent is responding we replace the placeholder
              // with a status message that tells the user *why* the input
              // is disabled. Showing the regular "send a message…" text
              // here was confusing because typing did nothing.
              <Text color={THEME.busy} bold>
                <Spinner type="dots" />
                {"  "}
                Agent is responding… press Ctrl+C to interrupt
              </Text>
            ) : showPlaceholder ? (
              <Text color={THEME.fgMuted}>{placeholder}</Text>
            ) : (
              lines.map((line, idx) => (
                <Text key={`line-${String(idx)}`} color={THEME.fgPrimary} wrap="wrap">
                  {line.length === 0 ? " " : line}
                </Text>
              ))
            )}
          </Box>
        </Box>
      </Box>

      {/* Footer — keybindings */}
      <Box marginTop={0} paddingX={1} flexDirection="row" gap={1} flexWrap="wrap">
        <Text color={THEME.fgMuted}>📁 {shortPath(resolvedCwd)}</Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgMuted}>
          <Text color={THEME.brand} bold>↵</Text> send
        </Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgMuted}>
          <Text color={THEME.brand} bold>⇧↵</Text> newline
        </Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgMuted}>
          <Text color={THEME.brand} bold>/</Text> commands
        </Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgMuted}>
          <Text color={THEME.brand} bold>^C</Text>
          {streaming ? " interrupt" : " quit"}
        </Text>
        {isMultiline ? (
          <>
            <Text color={THEME.border}>{GLYPHS.separator}</Text>
            <Text color={THEME.brand} bold>
              multiline
            </Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
// packages/tui/src/hooks/useInput.ts
// Capture keyboard input for the TUI's input bar.
//
// Wraps Ink's `useInput` and adds:
//   - Enter → submit
//   - Shift+Enter → newline (multiline mode)
//   - Arrow up / Arrow down → navigate the in-memory command history
//   - Ctrl+C → interrupt the running agent
//   - Slash command autocomplete suggestions
//
// The hook is pure with respect to the store: it only reads the
// `inputHistory` and `isStreaming` slices and dispatches user input back
// through callbacks supplied by the caller.

import { useCallback, useMemo, useState } from "react";
import { useInput as useInkInput } from "ink";

import { useTuiStore } from "../state/store.js";

/** Definition of a slash command the InputBar can autocomplete. */
export interface SlashCommand {
  readonly name: string;
  readonly description: string;
  readonly argumentHint?: string;
}

/** The complete list of built-in slash commands. */
export const BUILTIN_SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "help", description: "Show available commands" },
  { name: "clear", description: "Clear the chat history" },
  {
    name: "mode",
    argumentHint: "<plan|auto|full>",
    description: "Switch the agent's permission mode",
  },
  { name: "model", description: "Show the active model and provider" },
  {
    name: "models",
    description: "List models from local LLM backends (Ollama, LM Studio)",
  },
  { name: "tools", description: "List the available tools" },
  { name: "sessions", description: "List persisted sessions" },
  { name: "mcp", description: "List MCP servers attached to this session" },
  { name: "interrupt", description: "Interrupt the running agent" },
  { name: "exit", description: "Quit the TUI" },
];

/** Result returned by {@link useInput}. */
export interface UseInputResult {
  /** Current value of the input buffer. */
  readonly value: string;
  /** Replace the input buffer (used when navigating history). */
  readonly setValue: (next: string) => void;
  /** Currently visible slash-command suggestions, if any. */
  readonly suggestions: readonly SlashCommand[];
  /** Clear the input buffer. */
  readonly reset: () => void;
  /**
   * Submit the current buffer. If the buffer is a slash command, the supplied
   * `onCommand` is invoked and the buffer is cleared. Otherwise `onSubmit`
   * receives the raw text.
   */
  readonly submit: () => void;
  /** True if the current buffer looks like the start of a slash command. */
  readonly isAutocompleting: boolean;
}

/** Public configuration of {@link useInput}. */
export interface UseInputOptions {
  /** Called when the user presses Enter on a non-slash buffer. */
  readonly onSubmit: (text: string) => void;
  /** Called when the buffer is a recognised slash command. */
  readonly onCommand: (command: SlashCommand, raw: string) => void;
  /** Called when the user presses Ctrl+C. */
  readonly onInterrupt: () => void;
  /** Override the slash-command list (defaults to the builtins). */
  readonly commands?: readonly SlashCommand[];
  /** Disable the hook entirely (e.g. while a modal is open). */
  readonly disabled?: boolean;
}

/**
 * Tokenise a raw input string. The only piece of syntax we care about is the
 * leading `/command`; the rest is treated as a single argument blob.
 */
function parseCommand(
  raw: string,
  commands: readonly SlashCommand[],
): SlashCommand | null {
  if (!raw.startsWith("/")) return null;
  const trimmed = raw.slice(1);
  if (trimmed.length === 0) return null;
  const firstSpace = trimmed.indexOf(" ");
  const head = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const match = commands.find((c) => c.name === head.toLowerCase());
  return match ?? null;
}

/**
 * Hook used by the `InputBar` component. Ink's `useInput` is called
 * unconditionally to keep the hook order stable across renders.
 */
export function useInput(options: UseInputOptions): UseInputResult {
  const commands = options.commands ?? BUILTIN_SLASH_COMMANDS;
  const [value, setValue] = useState<string>("");

  const pushHistory = useTuiStore((s) => s.pushInputHistory);
  const moveHistory = useTuiStore((s) => s.moveInputHistory);
  const resetHistoryIndex = useTuiStore((s) => s.resetInputHistoryIndex);

  const suggestions = useMemo<readonly SlashCommand[]>(() => {
    if (!value.startsWith("/")) return [];
    const query = value.slice(1).toLowerCase();
    if (query.length === 0) {
      return commands;
    }
    return commands.filter((c) => c.name.startsWith(query));
  }, [commands, value]);

  const reset = useCallback((): void => {
    setValue("");
    resetHistoryIndex();
  }, [resetHistoryIndex]);

  const submit = useCallback((): void => {
    const text = value;
    if (text.trim().length === 0) return;
    const command = parseCommand(text, commands);
    if (command) {
      pushHistory(text);
      reset();
      options.onCommand(command, text);
      return;
    }
    pushHistory(text);
    reset();
    options.onSubmit(text);
  }, [commands, options, pushHistory, reset, value]);

  useInkInput(
    (input, key) => {
      if (options.disabled) return;

      // Ctrl+C: always available, even when the buffer is empty.
      if (key.ctrl && input === "c") {
        options.onInterrupt();
        return;
      }

      if (key.return) {
        // Shift+Enter is signalled as `return` + `shift` in Ink.
        if (key.shift) {
          setValue((prev) => `${prev}\n`);
          return;
        }
        submit();
        return;
      }

      if (key.upArrow) {
        const next = moveHistory(-1);
        if (next !== null) {
          setValue(next);
        }
        return;
      }
      if (key.downArrow) {
        const next = moveHistory(1);
        if (next === "") {
          setValue("");
        } else if (next !== null) {
          setValue(next);
        }
        return;
      }

      if (key.backspace || key.delete) {
        setValue((prev) => prev.slice(0, -1));
        return;
      }

      if (key.escape) {
        setValue("");
        resetHistoryIndex();
        return;
      }

      // Ignore lone control characters (anything not printable). Ink's
      // `input` parameter already filters out most of them, but tab/newline
      // come through as `\t` / `\r` and we do not want to inject them.
      if (input.length === 0) return;
      if (input === "\t" || input === "\r") return;

      setValue((prev) => prev + input);
    },
    { isActive: !options.disabled },
  );

  return {
    value,
    setValue,
    suggestions,
    reset,
    submit,
    isAutocompleting: suggestions.length > 0,
  };
}

/** Look up a slash command by name. Returns `null` if unknown. */
export function findCommand(
  name: string,
  commands: readonly SlashCommand[] = BUILTIN_SLASH_COMMANDS,
): SlashCommand | null {
  return commands.find((c) => c.name === name.toLowerCase()) ?? null;
}

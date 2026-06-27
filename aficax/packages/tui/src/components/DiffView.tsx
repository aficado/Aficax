// packages/tui/src/components/DiffView.tsx
// Renders a unified diff in the terminal with sensible colors:
//   - lines starting with `+` (but not `+++`) → green
//   - lines starting with `-` (but not `---`) → red
//   - lines starting with `@@`             → cyan (hunk header)
//   - everything else                       → dim gray (context)
//
// The component is purely presentational: callers pass a diff string (the
// output of `git diff`, `diff -u`, etc.) and we lay it out. We never try to
// compute or alter the diff ourselves.

import { Text } from "ink";

/** Props for the {@link DiffView} component. */
export interface DiffViewProps {
  /** Unified diff to display. Empty string is a no-op. */
  readonly diff: string;
  /**
   * Optional maximum width for the diff. Defaults to the terminal width
   * (Ink's `<Text>` handles that when `wrap` is set to `truncate-end`).
   */
  readonly width?: number;
  /** When `true` long lines are wrapped rather than truncated. */
  readonly wrap?: boolean;
}

interface DiffLine {
  readonly text: string;
  readonly kind: "add" | "remove" | "header" | "context";
}

/** Classify a single line of a unified diff. */
function classify(line: string): DiffLine {
  if (line.startsWith("@@")) return { text: line, kind: "header" };
  if (line.startsWith("+++") || line.startsWith("---")) {
    return { text: line, kind: "header" };
  }
  if (line.startsWith("+")) return { text: line, kind: "add" };
  if (line.startsWith("-")) return { text: line, kind: "remove" };
  return { text: line, kind: "context" };
}

/**
 * Render a unified diff. We split the input on `\n` ourselves so we can
 * colorise each line independently; the trailing newline is handled by
 * checking the length of the resulting array.
 */
export function DiffView({ diff, wrap = true }: DiffViewProps): JSX.Element {
  if (diff.length === 0) {
    return (
      <Text dimColor>(empty diff)</Text>
    );
  }

  const lines = diff.split("\n");
  // A trailing empty string from a final `\n` would render as a blank line.
  // Drop it to keep the view tight.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return (
    <Text wrap={wrap ? "wrap" : "truncate-end"}>
      {lines.map((line, idx) => {
        const cls = classify(line);
        const color =
          cls.kind === "add"
            ? "green"
            : cls.kind === "remove"
              ? "red"
              : cls.kind === "header"
                ? "cyan"
                : undefined;
        const dim = cls.kind === "context";
        return (
          <Text key={`diff-${String(idx)}`} color={color} dimColor={dim}>
            {line}
            {idx < lines.length - 1 ? "\n" : ""}
          </Text>
        );
      })}
    </Text>
  );
}

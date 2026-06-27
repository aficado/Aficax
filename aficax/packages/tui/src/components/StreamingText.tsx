// packages/tui/src/components/StreamingText.tsx
// Renders a string of text that is being streamed token by token.
//
// The component is intentionally simple — Ink already handles line wrapping
// and ANSI rendering. We just expose a small set of typography knobs (max
// width, dim trailing caret) so the surrounding panel can opt into a
// streaming aesthetic without reaching for `chalk` directly.

import { Text, type TextProps } from "ink";
import { useEffect, useState } from "react";

/** Props for the {@link StreamingText} component. */
export interface StreamingTextProps {
  readonly children: string;
  /** When `true` a faint cursor is rendered at the end of the text. */
  readonly active?: boolean;
  /** When `true` the cursor is hidden (used after the message is finalised). */
  readonly hideCursor?: boolean;
  /** Color passed through to Ink's `<Text>`. */
  readonly color?: TextProps["color"];
  /** Optional maximum width (soft-wrap by Ink). Defaults to terminal width. */
  readonly wrap?: "wrap" | "truncate" | "truncate-end";
}

/**
 * Render `children` with an optional blinking caret. The cursor blinks on
 * the parent's render cadence; we update a local state variable on an
 * interval so it animates even when no new props arrive.
 */
export function StreamingText({
  children,
  active = true,
  hideCursor = false,
  color,
  wrap = "wrap",
}: StreamingTextProps): JSX.Element {
  const [blinked, setBlinked] = useState<boolean>(false);

  useEffect(() => {
    if (!active || hideCursor) return undefined;
    const timer = setInterval(() => {
      setBlinked((prev) => !prev);
    }, 500);
    return () => clearInterval(timer);
  }, [active, hideCursor]);

  const showCaret = active && !hideCursor;

  return (
    <Text wrap={wrap} color={color}>
      {children}
      {showCaret ? (
        <Text color="gray">{blinked ? "▍" : " "}</Text>
      ) : null}
    </Text>
  );
}

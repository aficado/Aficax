// packages/tui/src/components/LoadingSpinner.tsx
// Animated terminal spinner used while the agent is thinking or executing a
// tool. The animation cadence is set to 120ms which looks smooth at typical
// terminal refresh rates (60Hz) without overwhelming slower terminals.

import { Text } from "ink";
import { useEffect, useState } from "react";

/** Props for the {@link LoadingSpinner} component. */
export interface LoadingSpinnerProps {
  /** Optional label rendered after the spinner glyph. */
  readonly label?: string;
  /** Color of the spinner glyph. Defaults to cyan. */
  readonly color?: "cyan" | "yellow" | "magenta" | "green" | "blue";
  /** Override the spinner's frame interval in milliseconds. */
  readonly intervalMs?: number;
  /** When `false` the spinner is replaced by a static "…" indicator. */
  readonly active?: boolean;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/**
 * Pure-presentational spinner. The component is safe to mount/unmount
 * repeatedly because the animation timer is cleaned up in the effect's
 * teardown.
 */
export function LoadingSpinner({
  label,
  color = "cyan",
  intervalMs = 120,
  active = true,
}: LoadingSpinnerProps): JSX.Element {
  const [frame, setFrame] = useState<number>(0);

  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % FRAMES.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);

  const glyph = active ? (FRAMES[frame] ?? FRAMES[0]) : "…";

  return (
    <Text>
      <Text color={color}>{glyph}</Text>
    </Text>
  );
}

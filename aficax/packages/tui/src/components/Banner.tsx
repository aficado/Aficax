// packages/tui/src/components/Banner.tsx
// Top header banner. Mimics the layout of Claude Code / OpenCode:
// a single rounded box with the agent name, model, provider and a
// live status indicator on the right.

import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface BannerProps {
  readonly model: string;
  readonly provider: string;
  readonly status: "ready" | "streaming" | "thinking" | "error";
  readonly sessionId: string;
}

export function Banner(props: BannerProps): JSX.Element {
  const statusLabel = formatStatus(props.status);
  const statusColor =
    props.status === "error"
      ? "red"
      : props.status === "streaming" || props.status === "thinking"
        ? "yellow"
        : "green";

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      flexDirection="row"
      justifyContent="space-between"
    >
      <Box>
        <Text bold color="cyan">
          {"✦ Aficax"}
        </Text>
        <Text dimColor> · </Text>
        <Text color="white">{props.model}</Text>
        <Text dimColor> · </Text>
        <Text color="gray">{props.provider}</Text>
      </Box>

      <Box>
        {(props.status === "streaming" || props.status === "thinking") ? (
          <Text color={statusColor}>
            <Spinner type="dots" /> {statusLabel}
          </Text>
        ) : (
          <Text color={statusColor}>● {statusLabel}</Text>
        )}
      </Box>
    </Box>
  );
}

function formatStatus(status: BannerProps["status"]): string {
  switch (status) {
    case "ready":
      return "ready";
    case "streaming":
      return "streaming";
    case "thinking":
      return "thinking";
    case "error":
      return "error";
  }
}
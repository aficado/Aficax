// packages/tui/src/components/ChatPanel.tsx
// Chat history. Each message renders inside its own coloured card so
// user turns, assistant turns, system notices and tool output are
// visually distinct without changing the data the loop sees.
//
//   ╭─ ❯ You ──────────────────────────────────╮
//   │ list the files                          │
//   ╰─────────────────────────────────────────╯
//
//   ╭─ ⏺ Aficax ───────────────────────────────╮
//   │ I'll list the files...                  │
//   ╰─────────────────────────────────────────╯

import { Box, Text } from "ink";
import Spinner from "ink-spinner";

import { useTuiStore, type ChatMessage, type MessageRole } from "../state/store.js";

import { Markdown } from "./Markdown.js";
import { GLYPHS, THEME } from "./theme.js";
import { ToolCall } from "./ToolCall.js";

export interface ChatPanelProps {
  readonly isStreaming: boolean;
  readonly pendingText: string;
}

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const messages = useTuiStore((s) => s.messages);

  if (messages.length === 0) {
    return <WelcomeScreen />;
  }

  return (
    <Box flexDirection="column">
      {messages.map((m) => (
        <Box key={m.id} marginBottom={1}>
          <MessageCard message={m} />
        </Box>
      ))}
      {props.isStreaming ? <StreamingIndicator text={props.pendingText} /> : null}
    </Box>
  );
}

function WelcomeScreen(): JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Text color={THEME.brand} bold>
          {GLYPHS.logo} Aficax
        </Text>
        <Text color={THEME.fgSecondary}> · ready to chat</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={THEME.fgPrimary}>Send a message below, or type </Text>
        <Box marginLeft={2}>
          <Text color={THEME.brand} bold>
            /help
          </Text>
          <Text color={THEME.fgSecondary}> for the list of available commands.</Text>
        </Box>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text color={THEME.fgSecondary} bold>Try one of these to get started:</Text>
        <Box marginTop={0} flexDirection="column" marginLeft={2}>
          <Box>
            <Text color={THEME.fgAccent}>  • </Text>
            <Text color={THEME.fgPrimary}>"list the files in this directory"</Text>
          </Box>
          <Box>
            <Text color={THEME.fgAccent}>  • </Text>
            <Text color={THEME.fgPrimary}>"what can you do?"</Text>
          </Box>
          <Box>
            <Text color={THEME.fgAccent}>  • </Text>
            <Text color={THEME.fgPrimary}>"explain what this project does"</Text>
          </Box>
          <Box>
            <Text color={THEME.fgAccent}>  • </Text>
            <Text color={THEME.fgPrimary}>"run the tests and summarise the failures"</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function MessageCard({ message }: { message: ChatMessage }): JSX.Element {
  const role = message.role as string;
  switch (role) {
    case "user":
      return <UserCard message={message} />;
    case "assistant":
      return <AssistantCard message={message} />;
    case "tool":
      return <ToolCard message={message} />;
    case "system":
    default:
      return <SystemCard message={message} />;
  }
}

function UserCard({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.userTag}
      paddingX={1}
    >
      <Box>
        <Text color={THEME.userTag} bold>
          {GLYPHS.prompt} You
        </Text>
      </Box>
      <Box paddingLeft={2} paddingRight={2} flexDirection="column">
        <Text color={THEME.fgPrimary} wrap="wrap">
          {message.content}
        </Text>
      </Box>
    </Box>
  );
}

function AssistantCard({ message }: { message: ChatMessage }): JSX.Element {
  const isStreaming = message.streaming === true;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={isStreaming ? THEME.brand : THEME.assistant}
      paddingX={1}
    >
      <Box>
        <Text color={THEME.assistantTag} bold>
          {GLYPHS.promptBusy} Aficax
        </Text>
        {isStreaming ? (
          <Text color={THEME.busy}>
            {" "}
            <Spinner type="dots" />
          </Text>
        ) : null}
        <Box flexGrow={1} />
        <Text color={THEME.fgMuted}>assistant</Text>
      </Box>
      <Box paddingLeft={2} paddingRight={2} flexDirection="column">
        {message.content.length === 0 ? (
          <Text color={THEME.fgMuted}>{"…"}</Text>
        ) : (
          <Markdown text={message.content} role="assistant" accent={THEME.assistant} />
        )}
      </Box>
    </Box>
  );
}

function SystemCard({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.borderMuted}
      paddingX={1}
    >
      <Box>
        <Text color={THEME.system} bold>
          {GLYPHS.bullet} system
        </Text>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        <Text color={THEME.fgSecondary} wrap="wrap">
          {message.content}
        </Text>
      </Box>
    </Box>
  );
}

function ToolCard({ message }: { message: ChatMessage }): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.borderMuted}
      paddingX={1}
    >
      <Box>
        <Text color={THEME.toolPending} bold>
          {GLYPHS.promptBusy} tool
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <ToolCall message={message} />
      </Box>
    </Box>
  );
}

function StreamingIndicator({ text }: { text: string }): JSX.Element {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={THEME.brand}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text color={THEME.assistantTag} bold>
          {GLYPHS.promptBusy} Aficax
        </Text>
        <Text color={THEME.busy}>
          {" "}
          <Spinner type="dots" />
        </Text>
      </Box>
      {text.length > 0 ? (
        <Box paddingLeft={2}>
          <Text color={THEME.fgSecondary} wrap="wrap">
            {truncate(text, 120)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}${GLYPHS.ellipsis}`;
}

// MessageRole is intentionally re-exported so downstream consumers
// can refer to the canonical union without re-importing from the store.
export type { MessageRole };
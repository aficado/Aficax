// packages/tui/src/components/Header.tsx
// Top-of-screen header. Two rows:
//
//   ╭─ ✦ Aficax  │  aficax-sess-abc  │  qwen2.5:7b  │  ollama ─╮
//   ╰─ ● ready · AUTO · 12.3k / 200k tokens ──────────────────╯
//
// The header shows every bit of context the user needs at a glance:
// brand, session id, model, provider, status, mode badge and the
// context-window consumption as a coloured progress bar.

import { Box, Text } from "ink";

import type { SessionInfo } from "../state/store.js";

import { GLYPHS, THEME, modeStyle } from "./theme.js";

export interface HeaderProps {
  readonly session: SessionInfo | null;
  readonly tokenCount?: { readonly used: number; readonly limit: number } | null;
}

const LOGO = `${GLYPHS.logo} Aficax`;

export function Header(props: HeaderProps): JSX.Element {
  const { session, tokenCount } = props;

  if (session === null) {
    return (
      <Box
        borderStyle="round"
        borderColor={THEME.border}
        paddingX={1}
        flexDirection="row"
        gap={1}
      >
        <Text color={THEME.brandBold} bold>
          {LOGO}
        </Text>
        <Text color={THEME.fgSecondary}>·</Text>
        <Text color={THEME.error}>no session</Text>
      </Box>
    );
  }

  const pct = tokenCount !== null && tokenCount !== undefined
    ? Math.min(100, Math.round((tokenCount.used / Math.max(1, tokenCount.limit)) * 100))
    : 0;
  const bar = renderBar(pct, 18);
  const barColor = pct > 80 ? THEME.tokenCritical : pct > 60 ? THEME.tokenWarn : THEME.tokenOk;
  const mode = modeStyle(session.mode);

  return (
    <Box flexDirection="column">
      {/* Top row — brand + identifiers */}
      <Box
        borderStyle="round"
        borderColor={THEME.border}
        paddingX={1}
        flexDirection="row"
        gap={1}
      >
        <Text color={THEME.brandBold} bold>
          {LOGO}
        </Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgPrimary}>{shortenId(session.id)}</Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.assistant} bold>
          {session.model}
        </Text>
        <Text color={THEME.border}>{GLYPHS.separator}</Text>
        <Text color={THEME.fgSecondary}>{session.provider}</Text>
        <Box flexGrow={1} />
        <Text color={mode.color} bold>
          [{mode.label}]
        </Text>
      </Box>

      {/* Bottom row — status + token bar */}
      <Box paddingX={1} marginTop={0} flexDirection="row" gap={1}>
        <Text color={THEME.ready} bold>
          ●
        </Text>
        <Text color={THEME.fgPrimary}>ready</Text>
        <Text color={THEME.fgSecondary}>·</Text>
        <Text color={mode.color}>{session.mode}</Text>
        <Text color={THEME.fgSecondary}>·</Text>
        {tokenCount !== null && tokenCount !== undefined ? (
          <>
            <Text color={barColor}>{bar}</Text>
            <Text color={barColor} bold>
              {" "}
              {String(pct)}%
            </Text>
            <Text color={THEME.fgSecondary}>
              {" "}
              ({formatTokens(tokenCount.used)}/{formatTokens(tokenCount.limit)} tokens)
            </Text>
          </>
        ) : (
          <Text color={THEME.fgSecondary}>— / — tokens</Text>
        )}
      </Box>
    </Box>
  );
}

function shortenId(id: string): string {
  if (id.length <= 28) return id;
  return `${id.slice(0, 20)}${GLYPHS.ellipsis}${id.slice(-6)}`;
}

function renderBar(pct: number, width: number): string {
  const filled = Math.round((pct / 100) * width);
  return (
    GLYPHS.barEdgeL +
    GLYPHS.barFull.repeat(filled) +
    GLYPHS.barEmpty.repeat(width - filled) +
    GLYPHS.barEdgeR
  );
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
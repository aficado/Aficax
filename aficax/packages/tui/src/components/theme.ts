// packages/tui/src/components/theme.ts
// Visual theme constants for the TUI. Centralising the colour palette
// and shared glyphs lets every component render with the same look
// without scattering magic numbers throughout the codebase.
//
// Only visual constants — no behaviour lives here.

type InkColor = string;

export const THEME = {
  // Brand
  brand: "cyanBright" as InkColor,
  brandBold: "cyan" as InkColor,

  // Status
  ready: "greenBright" as InkColor,
  busy: "yellowBright" as InkColor,
  error: "redBright" as InkColor,
  idle: "gray" as InkColor,

  // Message roles
  user: "whiteBright" as InkColor,
  userTag: "greenBright" as InkColor,
  assistant: "cyanBright" as InkColor,
  assistantTag: "cyanBright" as InkColor,
  system: "gray" as InkColor,

  // Mode badges
  modePlan: "yellow" as InkColor,
  modeAuto: "cyan" as InkColor,
  modeFull: "red" as InkColor,

  // Tool status
  toolPending: "blue" as InkColor,
  toolDone: "green" as InkColor,
  toolError: "red" as InkColor,
  toolDenied: "yellow" as InkColor,

  // Tokens / context bar
  tokenOk: "green" as InkColor,
  tokenWarn: "yellow" as InkColor,
  tokenCritical: "red" as InkColor,
  tokenMuted: "gray" as InkColor,

  // Surfaces
  border: "cyan" as InkColor,
  borderMuted: "gray" as InkColor,
  borderWarn: "yellow" as InkColor,
  borderError: "red" as InkColor,

  // Foreground helpers
  fgPrimary: "white" as InkColor,
  fgSecondary: "gray" as InkColor,
  fgMuted: "gray" as InkColor,
  fgAccent: "magenta" as InkColor,
} as const;

/** Glyphs that are shared across the layout. Using a single source
 *  of truth means a theme tweak is a one-line change. */
export const GLYPHS = {
  logo: "✦",
  prompt: "❯",
  promptBusy: "⏺",
  bullet: "•",
  arrow: "→",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  spinner: "⠋",
  barFull: "█",
  barEmpty: "░",
  barEdgeL: "▕",
  barEdgeR: "▏",
  branch: "⎿",
  ellipsis: "…",
  separator: "│",
  cornerTL: "╭",
  cornerTR: "╮",
  cornerBL: "╰",
  cornerBR: "╯",
  teeDown: "┬",
  teeUp: "┴",
  pipe: "│",
} as const;

/** Visual style for the current agent mode. */
export function modeStyle(mode: string): { color: InkColor; label: string } {
  switch (mode) {
    case "plan":
      return { color: THEME.modePlan, label: "PLAN" };
    case "full":
      return { color: THEME.modeFull, label: "FULL" };
    case "auto":
    default:
      return { color: THEME.modeAuto, label: "AUTO" };
  }
}

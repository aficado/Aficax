// packages/tui/src/components/Markdown.tsx
// Tiny markdown renderer. Handles the subset that Aficax actually
// emits: headers (`#`/`##`/`###`), bullet lists (`-`/`*`/`1.`),
// bold (`**text**`), inline code (`` `text` ``), and fenced code
// blocks (``` ```). Anything else renders verbatim. The component
// is intentionally small and dependency-free — the goal is "looks
// like markdown" rather than "is CommonMark".
//
// We render to a flat array of <Text> nodes; Ink handles wrapping
// when the terminal is narrower than the line.

import { Box, Text } from "ink";
import { Fragment } from "react";

export interface MarkdownProps {
  readonly text: string;
  /** Accent color for headings, blockquote bars, etc. */
  readonly accent?: string;
  /** Color for the `role` wrapper (user vs assistant). */
  readonly role: "user" | "assistant" | "system" | "tool";
}

const HEADING_PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly level: 1 | 2 | 3 }> = [
  { prefix: "### ", level: 3 },
  { prefix: "## ", level: 2 },
  { prefix: "# ", level: 1 },
];

export function Markdown(props: MarkdownProps): JSX.Element {
  const blocks = parseBlocks(props.text);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} accent={props.accent ?? "cyan"} />
      ))}
    </Box>
  );
}

interface CodeBlock {
  readonly kind: "code";
  readonly lang: string;
  readonly lines: readonly string[];
}
interface HeadingBlock {
  readonly kind: "heading";
  readonly level: 1 | 2 | 3;
  readonly text: string;
}
interface ListBlock {
  readonly kind: "list";
  readonly ordered: boolean;
  readonly items: readonly string[];
}
interface ParagraphBlock {
  readonly kind: "paragraph";
  readonly text: string;
}
interface BlankBlock {
  readonly kind: "blank";
}

type Block = CodeBlock | HeadingBlock | ListBlock | ParagraphBlock | BlankBlock;

function parseBlocks(text: string): readonly Block[] {
  const out: Block[] = [];
  const lines = text.split("\n");
  let i = 0;
  let paragraphBuffer: string[] = [];

  const flushParagraph = (): void => {
    if (paragraphBuffer.length === 0) return;
    out.push({ kind: "paragraph", text: paragraphBuffer.join("\n") });
    paragraphBuffer = [];
  };

  while (i < lines.length) {
    const line = lines[i] ?? "";

    // Fenced code block: ```lang\n...\n```
    if (/^```/.test(line)) {
      flushParagraph();
      const lang = line.replace(/^```/, "").trim();
      const inner: string[] = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i] ?? "")) {
        inner.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1; // skip closing fence
      out.push({ kind: "code", lang, lines: inner });
      continue;
    }

    // Headings.
    let matchedHeading = false;
    for (const h of HEADING_PREFIXES) {
      if (line.startsWith(h.prefix)) {
        flushParagraph();
        out.push({ kind: "heading", level: h.level, text: line.slice(h.prefix.length) });
        i += 1;
        matchedHeading = true;
        break;
      }
    }
    if (matchedHeading) continue;

    // Blank line — flush paragraph.
    if (line.trim().length === 0) {
      flushParagraph();
      out.push({ kind: "blank" });
      i += 1;
      continue;
    }

    // List (consecutive lines starting with `-`, `*`, or `N.`).
    const unorderedMatch = /^\s*[-*]\s+/.exec(line);
    const orderedMatch = /^\s*\d+\.\s+/.exec(line);
    if (unorderedMatch !== null || orderedMatch !== null) {
      flushParagraph();
      const ordered = orderedMatch !== null;
      const items: string[] = [];
      const re = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/;
      while (i < lines.length && re.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(re, ""));
        i += 1;
      }
      out.push({ kind: "list", ordered, items });
      continue;
    }

    // Default: paragraph.
    paragraphBuffer.push(line);
    i += 1;
  }
  flushParagraph();
  return out;
}

function BlockView({ block, accent }: { block: Block; accent: string }): JSX.Element {
  switch (block.kind) {
    case "blank":
      return <Text> </Text>;
    case "heading": {
      const prefix = "#".repeat(block.level);
      return (
        <Text bold color={accent}>
          {`${prefix} ${block.text}`}
        </Text>
      );
    }
    case "paragraph":
      return (
        <Text>
          <InlineText text={block.text} accent={accent} />
        </Text>
      );
    case "code":
      return (
        <Box
          borderStyle="round"
          borderColor="gray"
          flexDirection="column"
          paddingX={1}
          marginY={0}
        >
          {block.lang.length > 0 ? (
            <Text dimColor>{block.lang}</Text>
          ) : null}
          {block.lines.map((line, i) => (
            <Text key={i} color="gray">
              {line.length === 0 ? " " : line}
            </Text>
          ))}
        </Box>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              {block.ordered ? `${String(i + 1)}.` : "•"} <InlineText text={item} accent={accent} />
            </Text>
          ))}
        </Box>
      );
  }
}

/** Render a single line with inline markdown (bold + inline code). */
function InlineText({ text, accent }: { text: string; accent: string }): JSX.Element {
  const parts: Array<{ kind: "text" | "bold" | "code"; value: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    // Inline code: `...`
    if (text[cursor] === "`") {
      const end = text.indexOf("`", cursor + 1);
      if (end !== -1) {
        parts.push({ kind: "code", value: text.slice(cursor + 1, end) });
        cursor = end + 1;
        continue;
      }
    }
    // Bold: **...**
    if (text.startsWith("**", cursor)) {
      const end = text.indexOf("**", cursor + 2);
      if (end !== -1) {
        parts.push({ kind: "bold", value: text.slice(cursor + 2, end) });
        cursor = end + 2;
        continue;
      }
    }
    // Plain run until the next special char.
    const nextSpecial = findNextSpecial(text, cursor);
    parts.push({ kind: "text", value: text.slice(cursor, nextSpecial) });
    cursor = nextSpecial;
  }
  return (
    <>
      {parts.map((p, i) => {
        switch (p.kind) {
          case "text":
            return <Fragment key={i}>{p.value}</Fragment>;
          case "bold":
            return (
              <Text key={i} bold>
                {p.value}
              </Text>
            );
          case "code":
            return (
              <Text key={i} color={accent}>
                {`\`${p.value}\``}
              </Text>
            );
        }
      })}
    </>
  );
}

function findNextSpecial(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "`") return i;
    if (text.startsWith("**", i)) return i;
  }
  return text.length;
}
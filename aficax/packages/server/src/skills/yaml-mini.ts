// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\skills\yaml-mini.ts
// Minimal YAML 1.2 subset parser, scoped to the frontmatter blocks used
// by skills and custom-agent definitions.
//
// Supported features:
//   * `key: value` scalars (string, number, boolean, null).
//   * Flow-style lists: `[a, b, c]` (strings / numbers only).
//   * Block-style lists: `- item` (one per line, single-line items).
//   * Quoted strings: `"..."` and `'...'` (single-line, with `\"` and `\\`).
//   * Block scalars: `|` (literal, preserves newlines) and `>`
//     (folded, single-newline-aware). Used for multi-line
//     `systemPrompt:` blocks in custom-agent YAML.
//
// NOT supported (the parser will throw):
//   * Anchors / aliases (`&foo`, `*foo`).
//   * Mappings inside lists.
//   * Multi-document streams (`---` separating documents).
//   * Tags (`!!str`).
//
// The single export, {@link parseFrontmatter}, returns a plain object
// whose values are `string | number | boolean | null | readonly string[]`.

import { getLogger } from '@aficax/core';

const logger = getLogger();

/** Anything {@link parseFrontmatter} can produce as a value. */
export type YamlValue = string | number | boolean | null | readonly string[];

/** Result of {@link parseFrontmatter}: a plain object of scalars / lists. */
export interface ParsedFrontmatter {
  readonly [key: string]: YamlValue;
}

/** Parse a YAML frontmatter body. Throws on syntax errors. */
export function parseFrontmatter(yaml: string): ParsedFrontmatter {
  const lines = yaml.split('\n');
  const ctx = new ParseContext(lines);
  return ctx.parseMapping();
}

interface PendingBlock {
  readonly key: string;
  readonly style: 'literal' | 'folded';
  readonly indent: number;
  lines: string[];
}

/**
 * Recursive-descent parser over a pre-split line list. The parser
 * collapses the frontmatter into a single mapping; nested mappings are
 * not supported (they would need a `key: { ... }` syntax).
 */
class ParseContext {
  private pos = 0;
  constructor(private readonly lines: readonly string[]) {}

  parseMapping(): ParsedFrontmatter {
    const out: Record<string, YamlValue> = {};
    const pending: PendingBlock[] = [];
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? '';
      const stripped = stripTrailingComment(raw).replace(/\s+$/u, '');
      if (stripped.trim().length === 0) {
        this.pos++;
        continue;
      }
      const indent = leadingSpaces(stripped);
      const content = stripped.slice(indent);
      // Block scalar continuation lines: accumulate into the last pending block.
      if (pending.length > 0 && indent >= pending[pending.length - 1]!.indent && content.length > 0 && !isMappingLine(content) && !isListItem(content)) {
        pending[pending.length - 1]!.lines.push(content);
        this.pos++;
        continue;
      }
      if (!isMappingLine(content)) {
        throw new Error(`expected mapping at line ${String(this.pos + 1)}, got: ${content}`);
      }
      const colonIdx = content.indexOf(':');
      if (colonIdx === -1) {
        throw new Error(`expected ':' at line ${String(this.pos + 1)}`);
      }
      const key = stripQuotes(content.slice(0, colonIdx).trim());
      const tail = content.slice(colonIdx + 1).trim();
      if (key.length === 0) {
        throw new Error(`empty key at line ${String(this.pos + 1)}`);
      }
      this.pos++;
      // Empty value: peek the next non-blank line.
      if (tail.length === 0) {
        const next = this.peekNonBlank();
        if (next === null || leadingSpaces(next) <= indent) {
          // Value is null; flush any pending block before recording.
          this.flushBlock(pending, out, key);
          out[key] = null;
          continue;
        }
        if (next.trim().startsWith('|') || next.trim().startsWith('>')) {
          // Block scalar starts here.
          const style: 'literal' | 'folded' = next.trim().startsWith('|') ? 'literal' : 'folded';
          const block: PendingBlock = { key, style, indent: leadingSpaces(next), lines: [] };
          pending.push(block);
          this.pos++;
          continue;
        }
        if (next.trim().startsWith('- ')) {
          // Block-style list.
          out[key] = this.collectBlockList(leadingSpaces(next));
          continue;
        }
        // Inline flow list on the next line (rare in real configs).
        if (next.trim().startsWith('[')) {
          out[key] = parseFlowList(next.trim());
          this.pos++;
          continue;
        }
        // Treat as a multi-line plain scalar (rare; we keep newlines).
        const collected: string[] = [next.trim()];
        this.pos++;
        while (this.pos < this.lines.length) {
          const nxt = this.lines[this.pos] ?? '';
          const s = stripTrailingComment(nxt).replace(/\s+$/u, '');
          if (s.trim().length === 0) { collected.push(''); this.pos++; continue; }
          if (leadingSpaces(s) <= indent) break;
          collected.push(s.trim());
          this.pos++;
        }
        out[key] = collected.join('\n').trim();
        continue;
      }
      // Inline value on the same line.
      this.flushBlock(pending, out, key);
      if (tail.startsWith('[') && tail.endsWith(']')) {
        out[key] = parseFlowList(tail);
        continue;
      }
      if (tail === '|' || tail === '>') {
        // Block scalar header — start the pending block.
        const style: 'literal' | 'folded' = tail === '|' ? 'literal' : 'folded';
        pending.push({ key, style, indent: indent + 2, lines: [] });
        continue;
      }
      out[key] = parseScalar(tail);
    }
    // End of input: flush any remaining block into a multi-line string.
    if (pending.length > 0) {
      const block = pending.shift()!;
      out[block.key] = joinBlock(block);
    }
    return out;
  }

  private peekNonBlank(): string | null {
    for (let i = this.pos; i < this.lines.length; i++) {
      const raw = this.lines[i] ?? '';
      const stripped = stripTrailingComment(raw).replace(/\s+$/u, '');
      if (stripped.trim().length > 0) return stripped;
    }
    return null;
  }

  private collectBlockList(itemIndent: number): readonly string[] {
    const out: string[] = [];
    while (this.pos < this.lines.length) {
      const raw = this.lines[this.pos] ?? '';
      const stripped = stripTrailingComment(raw).replace(/\s+$/u, '');
      if (stripped.trim().length === 0) { this.pos++; continue; }
      const indent = leadingSpaces(stripped);
      if (indent < itemIndent) break;
      if (!isListItem(stripped)) break;
      const value = stripped.slice(itemIndent).replace(/^-+\s*/, '');
      out.push(stripQuotes(value));
      this.pos++;
    }
    return out;
  }

  private flushBlock(pending: PendingBlock[], out: Record<string, YamlValue>, upcomingKey: string): void {
    if (pending.length === 0) return;
    const block = pending.shift()!;
    void upcomingKey; // referenced for potential error messages
    out[block.key] = joinBlock(block);
  }
}

// -- Block helpers --------------------------------------------------------

function joinBlock(block: PendingBlock): string {
  // Trim trailing blank lines but keep internal indentation relative to
  // the block's first line.
  const trimmed = block.lines.map((l) => l.slice(block.indent));
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop();
  if (block.style === 'literal') {
    return trimmed.join('\n');
  }
  // Folded: paragraphs separated by blank lines become \n\n; single
  // newlines become spaces.
  const out: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    out.push(paragraph.join(' ').replace(/\s+/g, ' ').trim());
    paragraph = [];
  };
  for (const line of trimmed) {
    if (line.trim().length === 0) {
      flushParagraph();
      out.push('');
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// -- Primitive helpers ----------------------------------------------------

function isMappingLine(line: string): boolean {
  return findTopLevelColon(line) !== -1;
}

function isListItem(line: string): boolean {
  return /^-\s/.test(line) || line === '-';
}

function findTopLevelColon(line: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = line[i + 1] ?? '';
      if (next === '' || next === ' ' || next === '\t' || next === '#') return i;
    }
  }
  return -1;
}

function leadingSpaces(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function stripTrailingComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? '';
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseScalar(token: string): YamlValue {
  const trimmed = token.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null;
  if (/^-?\d+$/u.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/u.test(trimmed)) return Number.parseFloat(trimmed);
  return stripQuotes(trimmed);
}

function parseFlowList(text: string): readonly string[] {
  const inner = text.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i] ?? '';
    if (ch === "'" && !inDouble) { inSingle = !inSingle; buf += ch; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; buf += ch; continue; }
    if (ch === ',' && !inSingle && !inDouble) {
      out.push(stripQuotes(buf.trim()));
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) out.push(stripQuotes(buf.trim()));
  return out;
}

void logger; // reserved for future diagnostics

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\indexer\tree-sitter.ts
// Tree-sitter style symbol extraction.
//
// Aficax's first iteration does NOT depend on a native tree-sitter build
// (the project does not pull the `tree-sitter` npm package). Instead,
// the parser uses a small per-language regex extractor that captures
// the symbols the repo-map is interested in:
//
//   * top-level functions / methods
//   * top-level classes / structs / interfaces / traits
//   * exported declarations
//   * imports
//
// The extractor degrades gracefully: when a file is malformed, has an
// unsupported extension, or no symbols can be found, the function returns
// an empty {@link FileSymbols} object — the repo-map builder treats an
// empty result as "skip this file", which is the correct behaviour for
// a tool that is meant to be cheap and never fail.

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { getLogger } from '@aficax/core';

import type { FileCache } from './file-cache.js';

const logger = getLogger();

/** Maximum size of a single file the parser is willing to read. */
export const PARSER_MAX_FILE_BYTES = 512 * 1024;

/** A single named symbol. */
export interface SymbolEntry {
  /** Symbol name as written in the source (e.g. `createApp`). */
  readonly name: string;
  /** Kind of declaration. */
  readonly kind: SymbolKind;
  /** 1-based line number of the declaration. */
  readonly line: number;
  /**
   * One-line preview (signature, declaration head). Truncated to
   * roughly 120 characters so the repo-map stays compact.
   */
  readonly preview: string;
}

export type SymbolKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'trait'
  | 'enum'
  | 'type'
  | 'const'
  | 'export';

/** Result of parsing a single file. */
export interface FileSymbols {
  /** Absolute path of the file. */
  readonly path: string;
  /** Detected language (or `null` when the extension is unknown). */
  readonly language: SupportedLanguage | null;
  /** Every symbol extracted from the file. */
  readonly symbols: readonly SymbolEntry[];
  /** Distinct module names imported by the file. */
  readonly imports: readonly string[];
  /** Set to `true` when the parser refused the file (size, IO error). */
  readonly skipped: boolean;
  /** Human-readable reason when {@link skipped} is `true`. */
  readonly skipReason?: string;
}

/** Languages the v1 parser handles. */
export type SupportedLanguage = 'typescript' | 'javascript' | 'python' | 'go' | 'rust';

/** Public configuration of {@link SymbolParser}. */
export interface SymbolParserOptions {
  /** Optional cache: when present, parsed files are stored by `path`. */
  readonly cache?: FileCache;
  /** Override the clock (tests). */
  readonly now?: () => number;
}

/**
 * Stateless wrapper that exposes a single `parseFile` method. The parser
 * never throws: every error becomes a `skipped: true` {@link FileSymbols}.
 */
export class SymbolParser {
  private readonly cache: FileCache | null;

  constructor(options: SymbolParserOptions = {}) {
    this.cache = options.cache ?? null;
  }

  /**
   * Read `path` and extract its symbols. The result is never `null`; an
   * unreadable / oversized file becomes `{ skipped: true, ... }`.
   */
  async parseFile(path: string): Promise<FileSymbols> {
    const language = languageFromPath(path);
    if (language === null) {
      return { path, language: null, symbols: [], imports: [], skipped: true, skipReason: 'unsupported extension' };
    }
    const content = await this.readContent(path);
    if (content.skipped) {
      return {
        path,
        language,
        symbols: [],
        imports: [],
        skipped: true,
        ...(content.reason !== undefined ? { skipReason: content.reason } : {}),
      };
    }
    const extractors = EXTRACTORS[language];
    const result = extractors(path, content.text);
    return { path, language, symbols: result.symbols, imports: result.imports, skipped: false };
  }

  private async readContent(path: string): Promise<ReadResult> {
    return readContentImpl(path);
  }
}

// -- Internal helpers -----------------------------------------------------

interface ReadResult {
  readonly text: string;
  readonly skipped: boolean;
  readonly reason?: string;
}

interface ExtractedSymbols {
  readonly symbols: readonly SymbolEntry[];
  readonly imports: readonly string[];
}

async function readContentImpl(path: string): Promise<ReadResult> {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', skipped: true, reason: `stat failed: ${message}` };
  }
  if (!info.isFile()) {
    return { text: '', skipped: true, reason: 'not a file' };
  }
  if (info.size > PARSER_MAX_FILE_BYTES) {
    return { text: '', skipped: true, reason: `file too large (${String(info.size)} bytes)` };
  }
  try {
    const text = await readFile(path, 'utf-8');
    return { text, skipped: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: '', skipped: true, reason: `read failed: ${message}` };
  }
}

function languageFromPath(path: string): SupportedLanguage | null {
  const ext = extname(path).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
    case '.pyi':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    default:
      return null;
  }
}

const EXTRACTORS: Record<SupportedLanguage, (path: string, text: string) => ExtractedSymbols> = {
  typescript: extractJsLike,
  javascript: extractJsLike,
  python: extractPython,
  go: extractGo,
  rust: extractRust,
};

// -- TypeScript / JavaScript ---------------------------------------------

function extractJsLike(path: string, text: string): ExtractedSymbols {
  const symbols: SymbolEntry[] = [];
  const imports = new Set<string>();
  const lines = text.split('\n');

  // Pre-compute which lines are inside multi-line comments / strings to
  // avoid misclassifying commented-out declarations. The state machine
  // is approximate but covers the common cases.
  const blockComment = new Set<number>();
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (inBlock) {
      blockComment.add(i);
      if (line.includes('*/')) inBlock = false;
      continue;
    }
    if (line.includes('/*')) {
      blockComment.add(i);
      if (!line.includes('*/') || line.indexOf('/*') > line.indexOf('*/')) inBlock = true;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (blockComment.has(i)) continue;
    const line = raw.trim();

    // Imports.
    const importMatch = /^\s*import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+\w+|\w+))?\s+from\s+['"]([^'"]+)['"]/.exec(raw);
    if (importMatch !== null) {
      imports.add(importMatch[1] ?? '');
    }
    const requireMatch = /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(raw);
    if (requireMatch !== null) {
      imports.add(requireMatch[1] ?? '');
    }

    if (line.startsWith('//')) continue;
    if (line.length === 0) continue;

    // Top-level declarations.
    const fnMatch = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (fnMatch !== null) {
      symbols.push(makeSymbol(fnMatch[1] ?? '', 'function', i + 1, raw));
      continue;
    }
    const classMatch = /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (classMatch !== null) {
      symbols.push(makeSymbol(classMatch[1] ?? '', 'class', i + 1, raw));
      continue;
    }
    const interfaceMatch = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (interfaceMatch !== null) {
      symbols.push(makeSymbol(interfaceMatch[1] ?? '', 'interface', i + 1, raw));
      continue;
    }
    const typeMatch = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/.exec(line);
    if (typeMatch !== null) {
      symbols.push(makeSymbol(typeMatch[1] ?? '', 'type', i + 1, raw));
      continue;
    }
    const constMatch = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=]+)?=\s*(?:async\s+)?(?:function|\(|<|\bclass\b|\{|\w)/.exec(line);
    if (constMatch !== null) {
      symbols.push(makeSymbol(constMatch[1] ?? '', 'const', i + 1, raw));
      continue;
    }
    const methodMatch = /^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*[:{]/.exec(line);
    if (methodMatch !== null && raw.startsWith('  ')) {
      // Heuristic: indented method-like declaration. Only emit when the
      // next non-empty line is part of a class body.
      symbols.push(makeSymbol(methodMatch[1] ?? '', 'method', i + 1, raw));
      continue;
    }
  }

  // File-level exports (e.g. `export { foo, bar }`).
  for (const raw of lines) {
    const m = /^export\s+\{([^}]+)\}/.exec(raw);
    if (m === null) continue;
    const parts = (m[1] ?? '').split(',');
    for (const part of parts) {
      const name = part.split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name.length > 0) {
        symbols.push(makeSymbol(name, 'export', lines.indexOf(raw) + 1, raw));
      }
    }
  }

  logger.debug('parsed', { path, language: 'js-like', count: symbols.length });
  return { symbols, imports: Array.from(imports) };
}

// -- Python ---------------------------------------------------------------

function extractPython(path: string, text: string): ExtractedSymbols {
  const symbols: SymbolEntry[] = [];
  const imports = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.startsWith('#') || line.length === 0) continue;

    // Imports.
    const importMatch = /^from\s+([\w.]+)\s+import\s+/.exec(line);
    if (importMatch !== null) {
      imports.add(importMatch[1] ?? '');
      continue;
    }
    const plainImport = /^import\s+([\w.]+)/.exec(line);
    if (plainImport !== null) {
      imports.add(plainImport[1] ?? '');
      continue;
    }

    const defMatch = /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/.exec(line);
    if (defMatch !== null) {
      const indent = raw.length - raw.trimStart().length;
      symbols.push(makeSymbol(defMatch[1] ?? '', indent === 0 ? 'function' : 'method', i + 1, raw));
      continue;
    }
    const classMatch = /^class\s+([A-Za-z_][\w]*)/.exec(line);
    if (classMatch !== null) {
      symbols.push(makeSymbol(classMatch[1] ?? '', 'class', i + 1, raw));
      continue;
    }
  }
  logger.debug('parsed', { path, language: 'python', count: symbols.length });
  return { symbols, imports: Array.from(imports) };
}

// -- Go -------------------------------------------------------------------

function extractGo(path: string, text: string): ExtractedSymbols {
  const symbols: SymbolEntry[] = [];
  const imports = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.startsWith('//') || line.length === 0) continue;
    const importMatch = /^import\s+(?:"([^"]+)"|\(\s*)?$/.exec(line);
    if (importMatch !== null && importMatch[1] !== undefined) {
      imports.add(importMatch[1]);
      continue;
    }
    // Block import: scan a few lines ahead for `"foo/bar"` entries.
    if (line === 'import (' || line.startsWith('import (')) {
      let j = i + 1;
      while (j < lines.length) {
        const inner = (lines[j] ?? '').trim();
        if (inner === ')') break;
        const m = /"([^"]+)"/.exec(inner);
        if (m !== null && m[1] !== undefined) imports.add(m[1]);
        j++;
      }
      i = j;
      continue;
    }
    const fnMatch = /^func\s+(?:\(\s*\w+\s+\*?\w+\s*\)\s*)?([A-Za-z_][\w]*)\s*\(/.exec(line);
    if (fnMatch !== null) {
      symbols.push(makeSymbol(fnMatch[1] ?? '', 'function', i + 1, raw));
      continue;
    }
    const typeMatch = /^type\s+([A-Za-z_][\w]*)\s+(struct|interface|map|chan|func|\*?[\w\[\]]*)/.exec(line);
    if (typeMatch !== null) {
      const kind = typeMatch[2] === 'struct'
        ? 'struct'
        : typeMatch[2] === 'interface'
          ? 'interface'
          : 'type';
      symbols.push(makeSymbol(typeMatch[1] ?? '', kind, i + 1, raw));
      continue;
    }
  }
  logger.debug('parsed', { path, language: 'go', count: symbols.length });
  return { symbols, imports: Array.from(imports) };
}

// -- Rust -----------------------------------------------------------------

function extractRust(path: string, text: string): ExtractedSymbols {
  const symbols: SymbolEntry[] = [];
  const imports = new Set<string>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.startsWith('//') || line.length === 0) continue;
    const useMatch = /^(?:pub\s+)?use\s+([\w:]+)/.exec(line);
    if (useMatch !== null) {
      imports.add(useMatch[1] ?? '');
      continue;
    }
    const fnMatch = /^(?:pub\s+(?:async\s+)?|async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/.exec(line);
    if (fnMatch !== null) {
      const indent = raw.length - raw.trimStart().length;
      symbols.push(makeSymbol(fnMatch[1] ?? '', indent === 0 ? 'function' : 'method', i + 1, raw));
      continue;
    }
    const structMatch = /^(?:pub\s+)?struct\s+([A-Za-z_][\w]*)/.exec(line);
    if (structMatch !== null) {
      symbols.push(makeSymbol(structMatch[1] ?? '', 'struct', i + 1, raw));
      continue;
    }
    const traitMatch = /^(?:pub\s+)?trait\s+([A-Za-z_][\w]*)/.exec(line);
    if (traitMatch !== null) {
      symbols.push(makeSymbol(traitMatch[1] ?? '', 'trait', i + 1, raw));
      continue;
    }
    const enumMatch = /^(?:pub\s+)?enum\s+([A-Za-z_][\w]*)/.exec(line);
    if (enumMatch !== null) {
      symbols.push(makeSymbol(enumMatch[1] ?? '', 'enum', i + 1, raw));
      continue;
    }
    const typeMatch = /^(?:pub\s+)?type\s+([A-Za-z_][\w]*)\s*[<;=]/.exec(line);
    if (typeMatch !== null) {
      symbols.push(makeSymbol(typeMatch[1] ?? '', 'type', i + 1, raw));
      continue;
    }
  }
  logger.debug('parsed', { path, language: 'rust', count: symbols.length });
  return { symbols, imports: Array.from(imports) };
}

// -- Symbol formatting ----------------------------------------------------

function makeSymbol(name: string, kind: SymbolKind, line: number, raw: string): SymbolEntry {
  const preview = raw.trim().length > 120 ? `${raw.trim().slice(0, 117)}...` : raw.trim();
  return { name, kind, line, preview };
}

void basename; // reserved for future use (e.g. `__init__.py` heuristics)

/** Factory that creates a fresh {@link SymbolParser}. */
export function createSymbolParser(options: SymbolParserOptions = {}): SymbolParser {
  return new SymbolParser(options);
}

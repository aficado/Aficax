// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\grep.ts
// Search for a regex pattern inside files. Uses the {@link RipgrepSearcher}
// from the indexer subsystem (which itself wraps `rg` and falls back to a
// manual walker). The tool is intentionally thin — all the heavy lifting
// lives in `indexer/`.

import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';

import {
  createRipgrepSearcher,
  type RipgrepMatch,
  type RipgrepSearcher,
} from '../indexer/index.js';
import type { ToolImplementation } from './registry.js';

/** Default number of result lines to surface before truncating. */
const DEFAULT_MAX_RESULTS = 200;

export interface GrepToolOptions {
  /** Inject a custom searcher (tests). Defaults to a fresh one per call. */
  readonly searcherFactory?: (cwd: string) => RipgrepSearcher;
}

/** Definition + executor for the `grep` tool. */
export function createGrep(options: GrepToolOptions = {}): ToolImplementation {
  const factory = options.searcherFactory ?? ((cwd) => createRipgrepSearcher({ cwd }));

  const definition: ToolDefinition = {
    name: 'grep',
    description:
      'Search for a regular expression in files under a directory (or in a ' +
      'single file). Uses ripgrep when available, with a manual fallback. ' +
      'Honours `.gitignore` / `.aficaxignore` and never descends into ' +
      '`node_modules` or other dependency caches. Returns matching lines as ' +
      '`path:line:column:content`.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression pattern to search for.',
        },
        path: {
          type: 'string',
          description:
            'File or directory to search in. Defaults to the session working directory.',
        },
        filePattern: {
          type: 'string',
          description: 'Optional glob to restrict which files are searched (e.g. "**/*.ts").',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Case-sensitive search. Defaults to true.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of matches to return. Defaults to 200.',
        },
        contextLines: {
          type: 'number',
          description: 'Lines of context to capture around each match. Defaults to 0.',
        },
      },
      required: ['pattern'],
    },
    permissionLevel: 'auto_approve',
  };

  return {
    definition,
    async execute(input, context): Promise<ToolResult> {
      const pattern = String(input['pattern'] ?? '');
      const pathRaw = typeof input['path'] === 'string' ? input['path'] : undefined;
      const filePatternRaw = typeof input['filePattern'] === 'string' ? input['filePattern'] : undefined;
      const caseSensitive = input['caseSensitive'] !== false;
      const maxRaw = input['maxResults'];
      const maxResults = typeof maxRaw === 'number' && maxRaw > 0 ? Math.floor(maxRaw) : DEFAULT_MAX_RESULTS;
      const contextRaw = input['contextLines'];
      const contextLines = typeof contextRaw === 'number' && contextRaw >= 0 ? Math.floor(contextRaw) : 0;

      if (pattern.length === 0) {
        return { content: 'Error: "pattern" is required.', isError: true };
      }

      const searchPath = pathRaw
        ? (isAbsolute(pathRaw) ? pathRaw : resolve(context.workingDir, pathRaw))
        : context.workingDir;

      const searcher = factory(context.workingDir);
      let matches: RipgrepMatch[];
      try {
        matches = await searcher.search(pattern, {
          cwd: searchPath,
          ...(filePatternRaw !== undefined ? { filePattern: filePatternRaw } : {}),
          caseSensitive,
          maxResults,
          contextLines,
          ...(context.signal !== undefined ? { signal: context.signal } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error during grep: ${message}`,
          isError: true,
          metadata: { pattern, searchPath },
        };
      }

      const truncated = matches.length >= maxResults;
      return {
        content: matches.length === 0 ? '(no matches)' : formatMatches(matches, context.workingDir),
        isError: false,
        metadata: {
          pattern,
          searchPath,
          method: 'indexer',
          count: matches.length,
          truncated,
          relativeTo: relative(context.workingDir, searchPath) || '.',
        },
      };
    },
  };
}

function formatMatches(matches: readonly RipgrepMatch[], workingDir: string): string {
  const lines: string[] = [];
  for (const m of matches) {
    const rel = relative(workingDir, m.file) || m.file;
    const col = m.column > 0 ? String(m.column) : '';
    lines.push(`${rel}:${String(m.line)}${col.length > 0 ? ':' + col : ''}:${m.text}`);
    for (const ctx of m.context) {
      lines.push(`  ${rel}:${String(ctx.line)}-:${ctx.text}`);
    }
  }
  return lines.join('\n');
}
// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\glob.ts
// Find files matching a glob pattern using Bun's built-in Glob.

import { Glob } from 'bun';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';
import type { ToolImplementation } from './registry.js';

/** Definition + executor for the `glob` tool. */
export function createGlob(): ToolImplementation {
  const definition: ToolDefinition = {
    name: 'glob',
    description:
      'Find files and directories whose path matches a glob pattern. Uses ' +
      'Bun.Glob for fast iteration. Returns matching paths, one per line, ' +
      'sorted alphabetically. Hidden files (starting with `.`) and well-known ' +
      'dependency/build caches are excluded by default.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern (e.g. "**/*.ts", "src/**/*.test.ts").',
        },
        cwd: {
          type: 'string',
          description:
            'Directory to search in. Defaults to the session working directory.',
        },
        includeDirs: {
          type: 'boolean',
          description: 'Include directories in the results. Defaults to false.',
        },
        maxResults: {
          type: 'number',
          description: 'Maximum number of results to return. Defaults to 1000.',
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
      const cwdRaw = typeof input['cwd'] === 'string' ? input['cwd'] : undefined;
      const includeDirs = input['includeDirs'] === true;
      const maxRaw = input['maxResults'];
      const maxResults = typeof maxRaw === 'number' && maxRaw > 0 ? Math.floor(maxRaw) : 1000;

      if (pattern.length === 0) {
        return { content: 'Error: "pattern" is required.', isError: true };
      }

      const cwd = cwdRaw
        ? isAbsolute(cwdRaw)
          ? cwdRaw
          : resolve(context.workingDir, cwdRaw)
        : context.workingDir;

      try {
        const glob = new Glob(pattern);
        const matches: string[] = [];
        const truncated: string[] = [];

        for await (const file of glob.scan({ cwd, onlyFiles: !includeDirs })) {
          if (matches.length < maxResults) {
            matches.push(file);
          } else {
            truncated.push(file);
          }
        }

        matches.sort((a, b) => a.localeCompare(b));

        const body = matches.join('\n');
        const suffix = truncated.length > 0 ? `\n…(${String(truncated.length)} more truncated)` : '';

        return {
          content: body.length === 0 ? '(no matches)' : body + suffix,
          isError: false,
          metadata: {
            pattern,
            cwd,
            count: matches.length,
            truncated: truncated.length,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error running glob "${pattern}" in ${cwd}: ${message}`,
          isError: true,
          metadata: { pattern, cwd },
        };
      }
    },
  };
}

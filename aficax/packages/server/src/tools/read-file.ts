// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\read-file.ts
// Read the contents of a file, optionally restricted to a line range.

import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';
import type { ToolImplementation } from './registry.js';

/** Definition + executor for the `read_file` tool. */
export function createReadFile(): ToolImplementation {
  const definition: ToolDefinition = {
    name: 'read_file',
    description:
      'Read the contents of a file. Optionally read only a range of lines. ' +
      'Returns the content with line numbers prepended to each line.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or path relative to the session working directory.',
        },
        startLine: {
          type: 'number',
          description: 'Optional 1-indexed first line to read (inclusive).',
        },
        endLine: {
          type: 'number',
          description: 'Optional 1-indexed last line to read (inclusive).',
        },
      },
      required: ['path'],
    },
    permissionLevel: 'auto_approve',
  };

  return {
    definition,
    async execute(input, context): Promise<ToolResult> {
      const path = String(input['path'] ?? '');
      const startLineRaw = input['startLine'];
      const endLineRaw = input['endLine'];

      if (path.length === 0) {
        return { content: 'Error: "path" is required.', isError: true };
      }

      const startLine = typeof startLineRaw === 'number' ? startLineRaw : undefined;
      const endLine = typeof endLineRaw === 'number' ? endLineRaw : undefined;

      const absolutePath = isAbsolute(path) ? path : resolve(context.workingDir, path);

      try {
        const raw = await readFile(absolutePath, 'utf-8');
        const lines = raw.split(/\r?\n/);
        const total = lines.length;

        const start = startLine === undefined ? 1 : Math.max(1, Math.floor(startLine));
        const requestedEnd = endLine === undefined ? total : Math.floor(endLine);
        const end = Math.max(start, Math.min(total, requestedEnd));

        const slice = lines.slice(start - 1, end);
        const width = String(total).length;
        const numbered = slice
          .map((line, idx) => {
            const lineNo = start + idx;
            return `${String(lineNo).padStart(width, ' ')}\t${line}`;
          })
          .join('\n');

        return {
          content: numbered.length === 0 ? '(empty range)' : numbered,
          isError: false,
          metadata: {
            path: absolutePath,
            totalLines: total,
            startLine: start,
            endLine: end,
            bytes: Buffer.byteLength(raw, 'utf-8'),
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error reading file "${absolutePath}": ${message}`,
          isError: true,
          metadata: { path: absolutePath },
        };
      }
    },
  };
}

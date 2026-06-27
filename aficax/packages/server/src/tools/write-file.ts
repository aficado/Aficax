// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\write-file.ts
// Create or overwrite a file, creating intermediate directories and saving a
// checkpoint of the previous contents when an existing file is replaced.

import { access, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileHistoryDir } from '@aficax/core';
import type { ToolDefinition, ToolResult } from '@aficax/core';
import type { ToolImplementation } from './registry.js';

/**
 * Sanitize an absolute path into a flat filename usable as a checkpoint.
 * Replaces path separators and colons (Windows drive letters) with `_`.
 */
function safeCheckpointName(absolutePath: string): string {
  return absolutePath.replace(/[:\\/]/g, '_');
}

/** Definition + executor for the `write_file` tool. */
export function createWriteFile(): ToolImplementation {
  const definition: ToolDefinition = {
    name: 'write_file',
    description:
      'Create or overwrite a file. Intermediate directories are created if they ' +
      'do not exist. When overwriting an existing file, a copy of the previous ' +
      'contents is saved under the per-session file-history directory so the ' +
      'change can be reverted with /rewind.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or path relative to the session working directory.',
        },
        content: {
          type: 'string',
          description: 'The new file content to write.',
        },
      },
      required: ['path', 'content'],
    },
    permissionLevel: 'require_approval',
  };

  return {
    definition,
    async execute(input, context): Promise<ToolResult> {
      const path = String(input['path'] ?? '');
      const content = String(input['content'] ?? '');

      if (path.length === 0) {
        return { content: 'Error: "path" is required.', isError: true };
      }

      const absolutePath = isAbsolute(path) ? path : resolve(context.workingDir, path);

      let checkpointPath: string | null = null;

      try {
        // Probe for an existing file so we can checkpoint it before overwriting.
        let existed = false;
        try {
          await access(absolutePath);
          existed = true;
        } catch {
          existed = false;
        }

        if (existed) {
          const ts = Date.now();
          const historyDir = fileHistoryDir(context.sessionId);
          checkpointPath = join(historyDir, `${String(ts)}_${safeCheckpointName(absolutePath)}`);
          await mkdir(historyDir, { recursive: true });
          await copyFile(absolutePath, checkpointPath);
        }

        // Ensure parent directories exist, then write.
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, content, 'utf-8');

        const bytes = Buffer.byteLength(content, 'utf-8');
        const summary =
          checkpointPath !== null
            ? `Wrote ${String(bytes)} bytes to ${absolutePath} (checkpoint: ${checkpointPath})`
            : `Wrote ${String(bytes)} bytes to ${absolutePath} (new file)`;

        return {
          content: summary,
          isError: false,
          metadata: {
            path: absolutePath,
            bytes,
            existed,
            checkpointPath,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error writing file "${absolutePath}": ${message}`,
          isError: true,
          metadata: { path: absolutePath, checkpointPath },
        };
      }
    },
  };
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\list-directory.ts
// List the contents of a directory, optionally recursing. Filtering of
// dotfiles, dependency caches, and `.gitignore` patterns is delegated
// to the {@link IgnoreHandler} so the tool respects every project's
// individual ignore configuration.

import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';

import { createIgnoreHandler, type IgnoreHandler } from '../indexer/index.js';
import type { ToolImplementation } from './registry.js';

export interface ListDirectoryOptions {
  /** Inject a custom ignore handler factory (tests). */
  readonly ignoreFactory?: (cwd: string) => IgnoreHandler;
}

/** Build a small visual tree. */
function renderTree(entries: readonly { relPath: string; isDir: boolean; depth: number }[]): string {
  if (entries.length === 0) {
    return '(empty)';
  }
  return entries
    .map((entry) => {
      const indent = '  '.repeat(entry.depth);
      const icon = entry.isDir ? '📁' : '📄';
      return `${indent}${icon} ${entry.relPath}${entry.isDir ? '/' : ''}`;
    })
    .join('\n');
}

/** Definition + executor for the `list_directory` tool. */
export function createListDirectory(options: ListDirectoryOptions = {}): ToolImplementation {
  const factory = options.ignoreFactory ?? ((cwd) => {
    const handler = createIgnoreHandler({ cwd });
    void handler.load();
    return handler;
  });

  const definition: ToolDefinition = {
    name: 'list_directory',
    description:
      'List the contents of a directory. When `recursive` is true, descend ' +
      'into subdirectories and produce a tree view. Honours `.gitignore`, ' +
      '`.aficaxignore`, dotfiles, and well-known dependency / build caches ' +
      '(`node_modules`, `dist`, `target`, ...).',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path, or path relative to the session working directory.',
        },
        recursive: {
          type: 'boolean',
          description: 'Recurse into subdirectories. Defaults to false.',
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
      const recursive = input['recursive'] === true;

      if (path.length === 0) {
        return { content: 'Error: "path" is required.', isError: true };
      }

      const absolutePath = isAbsolute(path) ? path : resolve(context.workingDir, path);

      try {
        const target = await stat(absolutePath);
        if (!target.isDirectory()) {
          return {
            content: `Error: "${absolutePath}" is not a directory.`,
            isError: true,
            metadata: { path: absolutePath },
          };
        }

        const ignore = factory(context.workingDir);
        const collected: { relPath: string; isDir: boolean; depth: number }[] = [];
        const visited = new Set<string>();
        await walk(absolutePath, absolutePath, 0, recursive, ignore, collected, visited);

        return {
          content: renderTree(collected),
          isError: false,
          metadata: {
            path: absolutePath,
            recursive,
            count: collected.length,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error listing directory "${absolutePath}": ${message}`,
          isError: true,
          metadata: { path: absolutePath },
        };
      }
    },
  };
}

async function walk(
  base: string,
  current: string,
  depth: number,
  recursive: boolean,
  ignore: IgnoreHandler,
  out: { relPath: string; isDir: boolean; depth: number }[],
  visited: Set<string>,
): Promise<void> {
  // Cycle / symlink-loop guard.
  if (visited.has(current)) return;
  visited.add(current);

  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  // Sort: directories first, then alphabetical.
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) {
      return a.isDirectory() ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    const entryPath = join(current, entry.name);
    if (ignore.shouldIgnore(entryPath, entry.isDirectory())) continue;
    const relPath = relative(base, entryPath);
    out.push({ relPath, isDir: entry.isDirectory(), depth });

    if (recursive && entry.isDirectory()) {
      await walk(base, entryPath, depth + 1, recursive, ignore, out, visited);
    }
  }
}
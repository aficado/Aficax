// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\repo-map.ts
// `repo_map` tool: returns the compact repository digest maintained by
// the {@link RepoMap} subsystem. The tool is read-only and auto-approved
// — it surfaces a pre-computed summary so the agent can orient itself
// without re-walking the tree.

import { isAbsolute, resolve } from 'node:path';
import type { ToolDefinition, ToolResult } from '@aficax/core';

import {
  createRepoMap,
  type RepoMap,
  type RepoMapOptions,
} from '../indexer/index.js';
import type { ToolImplementation } from './registry.js';

export interface RepoMapToolOptions {
  /**
   * Inject a custom map factory. The default builds a fresh map per
   * invocation; production code typically wires a long-lived map into
   * this slot so consecutive calls are O(1).
   */
  readonly mapFactory?: (cwd: string) => RepoMap;
  /** Forwarded to {@link RepoMap.build} when constructing the map. */
  readonly repoMapOptions?: Omit<RepoMapOptions, 'cwd'>;
}

/** Definition + executor for the `repo_map` tool. */
export function createRepoMapTool(options: RepoMapToolOptions = {}): ToolImplementation {
  const factory = options.mapFactory ?? ((cwd) => createRepoMap({ cwd, ...(options.repoMapOptions ?? {}) }));

  const definition: ToolDefinition = {
    name: 'repo_map',
    description:
      'Return a compact, model-friendly digest of the repository at the ' +
      'session working directory: file paths grouped with the symbols ' +
      'they declare (functions, classes, exports, ...). Capped to roughly ' +
      '4000 tokens so it can be injected into the prompt without ' +
      'dominating the budget. Honours `.gitignore` and dependency caches.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Optional override for the directory to map. Defaults to the session working directory.',
        },
        force: {
          type: 'boolean',
          description:
            'Force a full rebuild even when a cached map exists. Defaults to false.',
        },
      },
    },
    permissionLevel: 'auto_approve',
  };

  return {
    definition,
    async execute(input, context): Promise<ToolResult> {
      const pathRaw = typeof input['path'] === 'string' ? input['path'] : undefined;
      const force = input['force'] === true;

      const cwd = pathRaw
        ? (isAbsolute(pathRaw) ? pathRaw : resolve(context.workingDir, pathRaw))
        : context.workingDir;
      const map = factory(cwd);

      try {
        const rendered = force || map.size === 0
          ? await map.build()
          : map.lastBuiltAt > 0
            ? map.render()
            : await map.build();

        return {
          content: rendered,
          isError: false,
          metadata: {
            cwd,
            files: map.size,
            builtAt: map.lastBuiltAt,
            forced: force,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: `Error building repo map: ${message}`,
          isError: true,
          metadata: { cwd, forced: force },
        };
      }
    },
  };
}
// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\registry.ts
// Server-side tool registry: pairs the core's ToolDefinition metadata with
// the actual execute function the server can call.

import type { ToolDefinition, ToolInput, ToolResult } from '@aficax/core';

/** Runtime context passed to every tool invocation. */
export interface ToolContext {
  /** Id of the session that triggered the tool call. */
  readonly sessionId: string;
  /** Absolute working directory the tool should operate in. */
  readonly workingDir: string;
  /** Abort signal triggered when the client disconnects or the loop is cancelled. */
  readonly signal?: AbortSignal;
}

/** A registered tool: metadata plus its execute function. */
export interface ToolImplementation {
  readonly definition: ToolDefinition;
  execute(input: ToolInput, context: ToolContext): Promise<ToolResult>;
}

/**
 * Map of tool name → implementation. Wraps the core's metadata-only
 * {@link ToolDefinition} with the server-side execute function.
 */
export class ToolRegistry {
  private readonly tools: Map<string, ToolImplementation> = new Map();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(impl: ToolImplementation): void {
    if (this.tools.has(impl.definition.name)) {
      throw new Error(`Tool "${impl.definition.name}" is already registered`);
    }
    this.tools.set(impl.definition.name, impl);
  }

  /** Look up a tool by name. Returns `undefined` if not registered. */
  get(name: string): ToolImplementation | undefined {
    return this.tools.get(name);
  }

  /** Check whether a tool with the given name is registered. */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Return the metadata of every registered tool. */
  definitions(): readonly ToolDefinition[] {
    const defs: ToolDefinition[] = [];
    for (const impl of this.tools.values()) {
      defs.push(impl.definition);
    }
    return defs;
  }

  /** Return the names of every registered tool. */
  names(): readonly string[] {
    return Array.from(this.tools.keys());
  }

  /** Number of registered tools. */
  size(): number {
    return this.tools.size;
  }
}

/** Factory that creates a fresh {@link ToolRegistry}. */
export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}

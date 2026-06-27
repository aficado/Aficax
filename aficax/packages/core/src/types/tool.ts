// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\tool.ts
// Tool interface, result type, and registry shape used by the agent loop.

/**
 * Coarse classification of how dangerous a tool invocation is.
 *
 * - `auto_approve`: the loop may run the tool without prompting the user.
 * - `require_approval`: the loop must pause and ask the user before running.
 * - `always_deny`: the tool is unconditionally rejected (e.g. unsafe command).
 */
export type PermissionLevel = 'auto_approve' | 'require_approval' | 'always_deny';

/** Input bag for a tool call. The shape is enforced by the tool's JSON Schema. */
export type ToolInput = Record<string, unknown>;

/** Structured payload returned by a tool after execution. */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  /** Optional side-band metadata (exit codes, parsed values, etc.). */
  readonly metadata?: Record<string, unknown>;
}

/**
 * JSON Schema describing a tool's input. Kept as a recursive alias so it can
 * model complex nested objects.
 */
export type JsonSchema = {
  readonly type?: string;
  readonly properties?: { readonly [key: string]: JsonSchema };
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly [key: string]: unknown;
};

/** Definition of a single tool exposed to the model. */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly permissionLevel: PermissionLevel;
  /**
   * Optional predicate evaluated against the concrete input to decide whether
   * a specific call needs user approval. Overrides the static permissionLevel.
   */
  readonly requiresApproval?: (input: ToolInput) => boolean;
}

/** Mutable registry of all tools available to the loop. */
export type ToolRegistry = Map<string, ToolDefinition>;

/** Create an empty tool registry. */
export function createToolRegistry(): ToolRegistry {
  return new Map<string, ToolDefinition>();
}

/** Register a tool. Throws if a tool with the same name already exists. */
export function registerTool(
  registry: ToolRegistry,
  tool: ToolDefinition,
): void {
  if (registry.has(tool.name)) {
    throw new Error(`Tool "${tool.name}" is already registered`);
  }
  registry.set(tool.name, tool);
}

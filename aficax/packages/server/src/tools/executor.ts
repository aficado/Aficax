// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\executor.ts
// Wraps a tool's execute function with timing, error capture, and logging.

import { getLogger, type ToolInput, type ToolResult } from '@aficax/core';
import type { ToolContext, ToolImplementation } from './registry.js';

const logger = getLogger();

/** Result of a single tool execution: the result + how long it took. */
export interface ExecutionResult {
  readonly result: ToolResult;
  readonly duration: number;
}

/**
 * Execute `tool` with the given `input` and `context`, measuring the elapsed
 * time. If the tool throws, the error is captured and returned as a
 * {@link ToolResult} with `isError: true` so the loop can continue.
 */
export async function executeTool(
  tool: ToolImplementation,
  input: ToolInput,
  context: ToolContext,
): Promise<ExecutionResult> {
  const start = Date.now();
  const toolName = tool.definition.name;

  logger.debug('Tool execution started', {
    tool: toolName,
    sessionId: context.sessionId,
  });

  try {
    const result = await tool.execute(input, context);
    const duration = Date.now() - start;

    logger.debug('Tool execution finished', {
      tool: toolName,
      sessionId: context.sessionId,
      duration,
      isError: result.isError,
    });

    return { result, duration };
  } catch (err) {
    const duration = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;

    logger.error('Tool execution crashed', {
      tool: toolName,
      sessionId: context.sessionId,
      duration,
      error: message,
    });
    if (stack !== undefined) {
      logger.debug('Tool crash stack', { tool: toolName, stack });
    }

    return {
      result: {
        content: `Internal tool error: ${message}`,
        isError: true,
        metadata: { crashed: true, tool: toolName },
      },
      duration,
    };
  }
}

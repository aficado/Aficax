// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\permission.ts
// Permission system types: user decisions and the requests that trigger them.

import type { SessionId } from './session.js';
import type { ToolInput } from './tool.js';

/** The four possible outcomes of a permission request. */
export type PermissionDecision =
  | 'approve'
  | 'deny'
  | 'approve_always'
  | 'deny_always';

/** Coarse risk level associated with a tool invocation. */
export type RiskLevel = 'low' | 'medium' | 'high';

/** A request from the loop asking the user to approve a tool call. */
export interface PermissionRequest {
  readonly toolName: string;
  readonly input: ToolInput;
  readonly sessionId: SessionId;
  readonly risk: RiskLevel;
  /** Human-readable explanation of why approval is being requested. */
  readonly reason: string;
}

/** The reply sent back from the user (or auto-decision) to the loop. */
export interface PermissionResponse {
  readonly request: PermissionRequest;
  readonly decision: PermissionDecision;
  readonly decidedAt: number;
}

/** Build a permission response with a decision and the current timestamp. */
export function makePermissionResponse(
  request: PermissionRequest,
  decision: PermissionDecision,
  decidedAt: number = Date.now(),
): PermissionResponse {
  return { request, decision, decidedAt };
}

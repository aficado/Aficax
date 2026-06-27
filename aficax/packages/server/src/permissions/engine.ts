// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\permissions\engine.ts
// PermissionEngine: the single source of truth for "may the agent run this
// tool right now?". The QueryEngine delegates every tool invocation to
// `checkPermission` before executing it.
//
// Decision flow (in order):
//   1. Mode gate: 'plan' / 'read-only' deny writes & execution; reads OK.
//   2. Denylist (session > project > global) → deny.
//   3. Allowlist (session > project > global) → approve.
//   4. Tool permissionLevel:
//        auto_approve  → approve (unless the mode gate already denied).
//        always_deny   → deny.
//        require_approval / undefined → fall through to step 5.
//   5. Danger classifier: 'critical' patterns always prompt.
//   6. Otherwise prompt the user (any permissionLevel other than the
//      always-on rules above triggers a `require_approval`).
//
// When we prompt, the engine:
//   a. generates an `approvalId`
//   b. registers a promise in `PendingApprovals` BEFORE emitting the event
//      (so a fast TUI response cannot miss the wait)
//   c. emits the `ApprovalRequestEvent` via the bus
//   d. awaits the promise (5-minute timeout by default)
//   e. turns 'approve_always' / 'deny_always' into an allowlist mutation.

import { randomUUID } from 'node:crypto';

import {
  getLogger,
  type PermissionDecision,
  type PermissionRequest,
  type RiskLevel,
  type SessionId,
  type ToolInput,
} from '@aficax/core';

import {
  createPendingApprovals,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  PendingApprovals,
  type ApprovalOutcome,
} from '../events/bus.js';
import type { EventBus } from '../events/bus.js';
import type { ToolRegistry } from '../tools/registry.js';

import { AllowlistStore, createAllowlistStore } from './allowlist.js';
import { classifyDanger, type Classification } from './classifier.js';

const logger = getLogger();

/** Agent permission modes. */
export type AgentMode = 'plan' | 'auto' | 'full' | 'read-only' | 'ci';

/** Why the engine arrived at its decision. Used in logs and UI. */
export type PermissionReason =
  | 'mode_denied'
  | 'denylist_match'
  | 'allowlist_match'
  | 'tool_auto_approve'
  | 'tool_always_deny'
  | 'user_approved'
  | 'user_denied'
  | 'user_approved_always'
  | 'user_denied_always'
  | 'timeout_denied'
  | 'aborted_denied'
  | 'classifier_critical'
  | 'tool_require_approval';

/** Result of a single permission check. */
export interface PermissionCheckResult {
  /** Final decision handed back to the QueryEngine. */
  readonly decision: PermissionDecision;
  /** Why we made the call (for logs / UI). */
  readonly reason: PermissionReason;
  /** Risk level assigned by the classifier (or derived from the tool). */
  readonly risk: RiskLevel;
  /** When `true` the loop should NOT execute the tool. */
  readonly denied: boolean;
  /** The request we sent to the TUI, when we prompted. */
  readonly request?: PermissionRequest;
  /** Details about the classification (if any). */
  readonly classification?: Classification;
}

/** Arguments to {@link PermissionEngine.checkPermission}. */
export interface CheckPermissionArgs {
  readonly toolName: string;
  readonly input: ToolInput;
  /** Stable id of the tool call (used as the approval id). */
  readonly toolCallId: string;
  readonly sessionId: SessionId;
  readonly workingDir: string;
  readonly mode: AgentMode;
  /** Abort signal that cancels the wait (loop interrupt, client disconnect). */
  readonly signal?: AbortSignal;
}

/** Collaborators required by the {@link PermissionEngine}. */
export interface PermissionEngineDeps {
  readonly toolRegistry: ToolRegistry;
  readonly allowlist: AllowlistStore;
  readonly bus: EventBus;
  readonly pending: PendingApprovals;
}

/** Tools considered read-only. Aligned with `classifier.ts`. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'glob',
  'grep',
]);

/** Default scope for "approve always" entries. */
const APPROVE_ALWAYS_SCOPE: 'session' | 'project' | 'global' = 'project';
/** Default scope for "deny always" entries. */
const DENY_ALWAYS_SCOPE: 'session' | 'project' | 'global' = 'global';

/**
 * The PermissionEngine. Stateless apart from its collaborators, so it is
 * safe to share across concurrent sessions.
 */
export class PermissionEngine {
  private readonly toolRegistry: ToolRegistry;
  private readonly allowlist: AllowlistStore;
  private readonly bus: EventBus;
  private readonly pending: PendingApprovals;

  constructor(deps: PermissionEngineDeps) {
    this.toolRegistry = deps.toolRegistry;
    this.allowlist = deps.allowlist;
    this.bus = deps.bus;
    this.pending = deps.pending;
  }

  /**
   * Decide whether `tool(input)` may run in `sessionId`. The returned
   * {@link PermissionCheckResult.decision} is one of the four
   * {@link PermissionDecision} values; `denied === true` means the loop
   * must skip execution and report a synthetic denial to the model.
   */
  async checkPermission(args: CheckPermissionArgs): Promise<PermissionCheckResult> {
    const tool = this.toolRegistry.get(args.toolName);
    const classification = classifyDanger(args.toolName, args.input, args.workingDir);

    // 1. Mode gate --------------------------------------------------------
    const modeVerdict = this.evaluateMode(args.mode, args.toolName);
    if (modeVerdict !== null) {
      logger.debug('Permission denied by mode', {
        mode: args.mode,
        toolName: args.toolName,
        sessionId: args.sessionId,
      });
      return {
        decision: 'deny',
        reason: 'mode_denied',
        risk: modeVerdict.risk,
        denied: true,
        classification,
      };
    }

    // 2. Denylist ---------------------------------------------------------
    if (await this.allowlist.isDenied(args.toolName, args.input)) {
      logger.debug('Permission denied by denylist', {
        toolName: args.toolName,
        sessionId: args.sessionId,
      });
      return {
        decision: 'deny',
        reason: 'denylist_match',
        risk: this.riskFromClassification(classification),
        denied: true,
        classification,
      };
    }

    // 3. Allowlist --------------------------------------------------------
    if (await this.allowlist.isAllowed(args.toolName, args.input)) {
      logger.debug('Permission granted by allowlist', {
        toolName: args.toolName,
        sessionId: args.sessionId,
      });
      return {
        decision: 'approve',
        reason: 'allowlist_match',
        risk: this.riskFromClassification(classification),
        denied: false,
        classification,
      };
    }

    // 4. Tool permissionLevel --------------------------------------------
    if (tool !== undefined) {
      if (tool.definition.permissionLevel === 'always_deny') {
        return {
          decision: 'deny',
          reason: 'tool_always_deny',
          risk: 'high',
          denied: true,
          classification,
        };
      }
      if (
        tool.definition.permissionLevel === 'auto_approve' &&
        classification.level !== 'critical' &&
        args.mode !== 'auto'
      ) {
        // The agent is in 'full' mode or the classifier is benign → safe.
        return {
          decision: 'approve',
          reason: 'tool_auto_approve',
          risk: this.riskFromClassification(classification),
          denied: false,
          classification,
        };
      }
      if (
        tool.definition.permissionLevel === 'auto_approve' &&
        classification.level === 'critical'
      ) {
        // Even normally-safe tools get re-checked if the classifier
        // flagged a critical pattern (e.g. read_file pointing at ~/.ssh).
        logger.warn('Critical pattern in tool usually auto-approved', {
          toolName: args.toolName,
          sessionId: args.sessionId,
          matched: classification.matchedPatterns.map((p) => p.id),
        });
      }
    }

    // 5. Classifier escalation -------------------------------------------
    if (classification.level === 'critical') {
      return this.requestApproval({
        args,
        classification,
        baseReason: 'classifier_critical',
      });
    }

    // 6. Default — prompt the user ---------------------------------------
    return this.requestApproval({
      args,
      classification,
      baseReason: 'tool_require_approval',
    });
  }

  // -- Internals ---------------------------------------------------------

  private async requestApproval(args: {
    readonly args: CheckPermissionArgs;
    readonly classification: Classification;
    readonly baseReason: PermissionReason;
  }): Promise<PermissionCheckResult> {
    const { toolName, input, sessionId, workingDir, toolCallId, signal } = args.args;
    const approvalId = `${sessionId}:${toolCallId}`;
    const risk = this.riskFromClassification(args.classification);
    const request: PermissionRequest = {
      sessionId,
      toolName,
      input,
      risk,
      reason: args.classification.reason,
    };

    // Register the wait BEFORE emitting the event so a fast response
    // cannot miss us. The registration throws if the id is duplicated;
    // we treat that as "another approval is in flight" and deny the new
    // request to avoid piling up parallel approvals for the same session.
    let waitPromise: Promise<ApprovalOutcome>;
    try {
      waitPromise = this.pending.register(approvalId, request, DEFAULT_APPROVAL_TIMEOUT_MS, signal);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to register approval, denying', {
        approvalId,
        toolName,
        error: message,
      });
      return {
        decision: 'deny',
        reason: 'denylist_match', // surfaces as "denied" without a special branch
        risk,
        denied: true,
        request,
        classification: args.classification,
      };
    }

    // Publish the request to every subscriber of this session (the TUI).
    this.bus.publish(sessionId, {
      type: 'approval_request',
      sessionId,
      timestamp: Date.now(),
      request,
    });

    let outcome: ApprovalOutcome;
    try {
      outcome = await waitPromise;
    } catch (err) {
      // register() never rejects in the current implementation, but be
      // defensive in case future changes re-introduce rejection.
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Approval wait failed, denying', {
        approvalId,
        toolName,
        error: message,
      });
      return {
        decision: 'deny',
        reason: 'aborted_denied',
        risk,
        denied: true,
        request,
        classification: args.classification,
      };
    }

    // 'approve_always' / 'deny_always' → persist before returning so the
    // very next invocation of the same tool is short-circuited.
    if (outcome.decision === 'approve_always') {
      await this.allowlist.addToAllowlist(toolName, input, APPROVE_ALWAYS_SCOPE);
      return {
        decision: 'approve',
        reason: 'user_approved_always',
        risk,
        denied: false,
        request,
        classification: args.classification,
      };
    }
    if (outcome.decision === 'deny_always') {
      await this.allowlist.addToDenylist(toolName, input, DENY_ALWAYS_SCOPE);
      return {
        decision: 'deny',
        reason: 'user_denied_always',
        risk,
        denied: true,
        request,
        classification: args.classification,
      };
    }

    if (outcome.auto && outcome.reason === 'timeout') {
      return {
        decision: 'deny',
        reason: 'timeout_denied',
        risk,
        denied: true,
        request,
        classification: args.classification,
      };
    }
    if (outcome.auto && outcome.reason === 'aborted') {
      return {
        decision: 'deny',
        reason: 'aborted_denied',
        risk,
        denied: true,
        request,
        classification: args.classification,
      };
    }

    if (outcome.decision === 'approve') {
      return {
        decision: 'approve',
        reason: 'user_approved',
        risk,
        denied: false,
        request,
        classification: args.classification,
      };
    }

    return {
      decision: 'deny',
      reason: 'user_denied',
      risk,
      denied: true,
      request,
      classification: args.classification,
    };
  }

  /**
   * Return a denial verdict for the current mode when the tool is not
   * permitted. `null` means the mode gate allows the tool.
   */
  private evaluateMode(
    mode: AgentMode,
    toolName: string,
  ): { readonly risk: RiskLevel } | null {
    if (mode === 'plan') {
      // Plan mode: allow reads only.
      if (READ_ONLY_TOOLS.has(toolName)) return null;
      return { risk: 'medium' };
    }
    if (mode === 'read-only') {
      // Same as plan, but a separate semantic label so the TUI can show
      // "read-only" explicitly when relevant.
      if (READ_ONLY_TOOLS.has(toolName)) return null;
      return { risk: 'medium' };
    }
    if (mode === 'full') {
      // Full mode: skip the read-only gate entirely.
      return null;
    }
    // 'auto' (default) lets everything through this gate; the
    // allowlist, classifier, and tool permissionLevel decide.
    return null;
  }

  private riskFromClassification(c: Classification): RiskLevel {
    switch (c.level) {
      case 'safe':
        return 'low';
      case 'medium':
        return 'medium';
      case 'high':
        return 'high';
      case 'critical':
        return 'high';
    }
  }

  /** Convenience: clear the session-scoped allowlist (call on session end). */
  clearSession(): void {
    this.allowlist.clearSession();
  }
}

/** Generate a fresh approval id. Exposed for tests. */
export function newApprovalId(): string {
  return randomUUID();
}

/** Convenience builder that wires up the default dependencies. */
export interface CreatePermissionEngineOptions {
  readonly toolRegistry: ToolRegistry;
  readonly bus: EventBus;
  readonly allowlist?: AllowlistStore;
  readonly pending?: PendingApprovals;
  readonly workingDir: string;
}

/**
 * Factory used by `server.ts` to build the engine with sensible defaults.
 * The allowlist and pending-approvals instances can be overridden in tests.
 */
export function createPermissionEngine(
  options: CreatePermissionEngineOptions,
): PermissionEngine {
  const allowlist = options.allowlist ?? createAllowlistStore({ workingDir: options.workingDir });
  const pending = options.pending ?? createPendingApprovals();
  return new PermissionEngine({
    toolRegistry: options.toolRegistry,
    bus: options.bus,
    allowlist,
    pending,
  });
}

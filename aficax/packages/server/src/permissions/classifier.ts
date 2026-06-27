// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\permissions\classifier.ts
// Classify a tool invocation into a discrete risk bucket that the
// `PermissionEngine` uses to decide whether to ask the user for approval.
//
// Buckets (lowest → highest):
//   safe      — read-only operations that cannot mutate state.
//   medium    — mutations inside the session working directory /
//               package-install / remote-transfer without execution.
//   high      — privilege escalation, persistence, dangerous pipes that
//               don't fire the critical heuristics, package install at
//               system scope.
//   critical  — destructive filesystem ops, credential access, pipes to
//               shell, direct writes to sensitive paths.
//
// The classifier is pure: it does not consult any I/O. Given the same
// `(tool, input, workingDir)` it always returns the same verdict, which
// makes it easy to test.

import { isAbsolute, relative, resolve } from 'node:path';

import type { ToolInput } from '@aficax/core';

import {
  DANGEROUS_PATTERNS,
  findMatchingPatterns,
  highestSeverity,
  type DangerousPattern,
  type PatternSeverity,
} from './patterns.js';

/** Severity buckets the classifier returns. */
export type DangerLevel = 'safe' | 'medium' | 'high' | 'critical';

/** Result of classifying a single tool call. */
export interface Classification {
  /** Final severity bucket. */
  readonly level: DangerLevel;
  /** Patterns that matched (empty when `level === 'safe'`). */
  readonly matchedPatterns: readonly DangerousPattern[];
  /** Short human-readable explanation suitable for the approval prompt. */
  readonly reason: string;
}

/** Tool names classified as "always safe" regardless of input. */
const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_directory',
  'glob',
  'grep',
]);

/** Tool names classified as "writes inside the workspace". */
const WORKSPACE_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'patch_file',
]);

/** Classify a tool invocation. */
export function classifyDanger(
  toolName: string,
  input: ToolInput,
  workingDir: string,
): Classification {
  // 1. Pure read tools → safe.
  if (READ_ONLY_TOOLS.has(toolName)) {
    return { level: 'safe', matchedPatterns: [], reason: 'read-only tool' };
  }

  // 2. Bash → scan the command string against every dangerous pattern.
  if (toolName === 'bash') {
    const command = extractBashCommand(input);
    if (command === null) {
      // No command? That's suspicious, but let the engine treat it as high.
      return {
        level: 'high',
        matchedPatterns: [],
        reason: 'bash invocation without a "command" string',
      };
    }
    const matches = findMatchingPatterns(command);
    if (matches.length === 0) {
      return { level: 'safe', matchedPatterns: [], reason: 'bash command is benign' };
    }
    return {
      level: highestSeverity(matches),
      matchedPatterns: matches,
      reason: matches.map((m) => m.description).join('; '),
    };
  }

  // 3. Workspace write tools → safe iff the resolved path stays inside
  //    `workingDir`. Otherwise escalate based on the destination.
  if (WORKSPACE_WRITE_TOOLS.has(toolName)) {
    const pathValue = extractPathField(input);
    if (pathValue === null) {
      return {
        level: 'high',
        matchedPatterns: [],
        reason: `${toolName} called without a path`,
      };
    }
    const classification = classifyWritePath(pathValue, workingDir);
    return classification;
  }

  // 4. Unknown / future tools: treat as high so the user is prompted.
  return {
    level: 'high',
    matchedPatterns: [],
    reason: `unknown tool "${toolName}" — defaulting to high`,
  };
}

/**
 * Convert a danger level to a {@link PatternSeverity}. The two are
 * compatible (both ascend from medium → high → critical), but the type
 * systems are kept separate to make the classifier's vocabulary explicit.
 */
export function toPatternSeverity(level: DangerLevel): PatternSeverity | 'low' {
  switch (level) {
    case 'safe':
      return 'low';
    case 'medium':
      return 'medium';
    case 'high':
      return 'high';
    case 'critical':
      return 'critical';
  }
}

// -- Helpers --------------------------------------------------------------

function extractBashCommand(input: ToolInput): string | null {
  const cmd = input['command'];
  return typeof cmd === 'string' && cmd.length > 0 ? cmd : null;
}

function extractPathField(input: ToolInput): string | null {
  const path = input['path'];
  return typeof path === 'string' && path.length > 0 ? path : null;
}

/**
 * Classify a write destination. Returns 'safe' when the path resolves inside
 * the working directory, otherwise escalates based on path patterns from
 * `patterns.ts`.
 */
function classifyWritePath(rawPath: string, workingDir: string): Classification {
  const absolutePath = isAbsolute(rawPath) ? rawPath : resolve(workingDir, rawPath);
  const rel = relative(workingDir, absolutePath);

  // Inside the workspace (and not escaping via `..`) → medium.
  if (rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)) {
    return {
      level: 'medium',
      matchedPatterns: [],
      reason: 'writes inside the session working directory',
    };
  }

  // Outside the workspace → check against sensitive-path patterns.
  const matches = findMatchingPatterns(absolutePath);
  if (matches.length > 0) {
    return {
      level: highestSeverity(matches),
      matchedPatterns: matches,
      reason: `writes outside the workspace to ${absolutePath}`,
    };
  }

  return {
    level: 'high',
    matchedPatterns: [],
    reason: `writes outside the workspace to ${absolutePath}`,
  };
}

/**
 * Convenience re-export so callers can list every pattern the classifier
 * considers without importing `patterns.ts` directly.
 */
export const ALL_PATTERNS = DANGEROUS_PATTERNS;

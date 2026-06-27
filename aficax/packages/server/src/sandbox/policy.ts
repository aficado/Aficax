// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\sandbox\policy.ts
// SandboxPolicy: the user-facing knobs that every sandbox backend
// enforces. The shape is intentionally backend-agnostic: each OS
// implementation translates the policy into its own primitives
// (bwrap flags, sandbox-exec profile, Windows job objects).
//
// Defaults are conservative — "no network, no credentials, kill on
// timeout" — because every other knob is something the user has to opt
// into deliberately.

import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

import { getLogger } from '@aficax/core';

const logger = getLogger();

/** Default execution timeout, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default CPU quota as a percentage of one core. */
export const DEFAULT_MAX_CPU_PERCENT = 50;
/** Default memory ceiling, in megabytes. */
export const DEFAULT_MAX_MEMORY_MB = 512;

/** Common credential-bearing paths that must never be readable. */
export const CREDENTIAL_PATHS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.kube',
  '.docker',
  '.config/gcloud',
  '.azure',
  '.netrc',
  '.npmrc',
  '.pypirc',
];

/** Public configuration of the sandbox. */
export interface SandboxPolicy {
  /** Master switch. When `false`, the bash tool runs unsandboxed. */
  readonly enabled: boolean;
  /** Paths the sandboxed process is allowed to read. */
  readonly allowedReadPaths: readonly string[];
  /** Paths the sandboxed process is allowed to write. */
  readonly allowedWritePaths: readonly string[];
  /** When `true`, outbound network is permitted. Default `false`. */
  readonly allowNetwork: boolean;
  /** When `allowNetwork` is `true`, the only domains that may be reached. */
  readonly allowedNetworkDomains: readonly string[];
  /** Soft CPU cap (percentage of one core). Default {@link DEFAULT_MAX_CPU_PERCENT}. */
  readonly maxCpuPercent: number;
  /** Hard memory cap (MB). Default {@link DEFAULT_MAX_MEMORY_MB}. */
  readonly maxMemoryMb: number;
  /** Wall-clock timeout (ms). Default {@link DEFAULT_TIMEOUT_MS}. */
  readonly timeout: number;
  /** Block access to known credential directories. Default `true`. */
  readonly blockCredentialPaths: boolean;
  /** Override the workspace path (defaults to `process.cwd()`). */
  readonly workspace: string;
}

/** Build a conservative default policy rooted at `workspace`. */
export function defaultSandboxPolicy(workspace?: string): SandboxPolicy {
  const ws = workspace && workspace.length > 0 ? normalisePath(workspace) : safeCwd();
  return {
    enabled: true,
    allowedReadPaths: [ws],
    allowedWritePaths: [ws],
    allowNetwork: false,
    allowedNetworkDomains: [],
    maxCpuPercent: DEFAULT_MAX_CPU_PERCENT,
    maxMemoryMb: DEFAULT_MAX_MEMORY_MB,
    timeout: DEFAULT_TIMEOUT_MS,
    blockCredentialPaths: true,
    workspace: ws,
  };
}

/** Merge `overrides` on top of `base`, dropping keys the caller did not set. */
export function mergeSandboxPolicy(base: SandboxPolicy, overrides: Partial<SandboxPolicy> | undefined): SandboxPolicy {
  if (overrides === undefined) return base;
  const next: SandboxPolicy = {
    ...base,
    ...overrides,
    allowedReadPaths: overrides.allowedReadPaths ?? base.allowedReadPaths,
    allowedWritePaths: overrides.allowedWritePaths ?? base.allowedWritePaths,
    allowedNetworkDomains: overrides.allowedNetworkDomains ?? base.allowedNetworkDomains,
  };
  // Normalise path lists so the backends do not have to.
  return {
    ...next,
    workspace: normalisePath(next.workspace),
    allowedReadPaths: next.allowedReadPaths.map(normalisePath),
    allowedWritePaths: next.allowedWritePaths.map(normalisePath),
  };
}

/**
 * Validate a policy. Returns an array of human-readable errors; an
 * empty array means the policy is acceptable.
 */
export function validateSandboxPolicy(policy: SandboxPolicy): readonly string[] {
  const errors: string[] = [];
  if (policy.maxCpuPercent <= 0 || policy.maxCpuPercent > 100) {
    errors.push(`maxCpuPercent must be in (0, 100] (got ${String(policy.maxCpuPercent)})`);
  }
  if (policy.maxMemoryMb <= 0) {
    errors.push(`maxMemoryMb must be positive (got ${String(policy.maxMemoryMb)})`);
  }
  if (policy.timeout <= 0) {
    errors.push(`timeout must be positive (got ${String(policy.timeout)})`);
  }
  if (policy.allowNetwork && policy.allowedNetworkDomains.length === 0) {
    errors.push('allowNetwork is true but allowedNetworkDomains is empty');
  }
  if (policy.enabled && policy.allowedWritePaths.length === 0) {
    errors.push('enabled sandbox must allow at least one write path');
  }
  return errors;
}

/** Resolve a path to absolute form. */
export function normalisePath(path: string): string {
  if (path.length === 0) return '.';
  return isAbsolute(path) ? path : resolve(path);
}

/** Absolute paths that should be blocked when `blockCredentialPaths` is on. */
export function credentialPathsToBlock(home: string = safeHomedir()): readonly string[] {
  return CREDENTIAL_PATHS.map((p) => resolve(home, p));
}

/** Diagnostic line for logs and the `/sandbox/status` route. */
export function summarisePolicy(policy: SandboxPolicy): string {
  const parts = [
    `enabled=${String(policy.enabled)}`,
    `network=${policy.allowNetwork ? 'on' : 'off'}`,
    `cpu=${String(policy.maxCpuPercent)}%`,
    `mem=${String(policy.maxMemoryMb)}MB`,
    `timeout=${String(policy.timeout)}ms`,
  ];
  if (policy.blockCredentialPaths) parts.push('credentials=blocked');
  return parts.join(' ');
}

/** Convenience: read the home directory with safe fallbacks. */
export function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

/** Best-effort fallback when `process.cwd` is unavailable. */
function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    return '.';
  }
}

void logger; // reserved for diagnostic logging when validation runs
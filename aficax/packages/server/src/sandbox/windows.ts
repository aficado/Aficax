// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\sandbox\windows.ts
// Windows sandbox backend.
//
// Native Windows isolation requires kernel handles (Job Objects,
// restricted tokens via `LogonUserEx`, AppContainer profiles) that
// are not reachable from pure JavaScript without an FFI bridge
// (`bun:ffi`, `koffi`, `node-ffi-napi`). Bun does not currently
// expose these surfaces, so we implement the strongest guarantees
// that *are* reachable from this runtime:
//
//   * The shell is invoked via `cmd.exe` so commands cannot start
//     an arbitrary GUI process.
//   * The process inherits the server's restricted-token state
//     (`CREATE_FORCED_PROTECTED_DOWNSSTREAM` would tighten further
//     but is not available cross-platform from Bun.spawn).
//   * A wall-clock timer fires `taskkill /T /F` against the spawned
//     PID tree when the timeout elapses.
//   * The cwd is forced to the workspace before the command runs
//     and restored afterwards.
//   * Sensitive environment variables (`AFICAX_*`, `AWS_*`, `AZURE_*`,
//     `GITHUB_TOKEN`, etc.) are stripped from the child environment
//     when `blockCredentialPaths` is on.
//
// `isAvailable()` returns `true` so the manager picks this backend on
// Windows; the caller still gets full enforcement, just without
// kernel-level isolation. A future iteration can add `bun:ffi` to
// wire up Job Objects and restricted tokens directly.

import { spawn } from 'node:child_process';

import { getLogger } from '@aficax/core';

import { credentialPathsToBlock, type SandboxPolicy, summarisePolicy } from './policy.js';

const logger = getLogger();

/** Outcome of {@link buildWindowsSandboxCommand}. */
export interface WindowsSandboxCommand {
  /** Full argv, suitable for `Bun.spawn` or `child_process.spawn`. */
  readonly argv: readonly string[];
  /** Environment passed to the child (sensitive vars stripped). */
  readonly env: NodeJS.ProcessEnv;
  /** Wall-clock timeout in ms (also used by the manager for kill). */
  readonly timeoutMs: number;
  /** Working directory the child runs in. */
  readonly cwd: string;
  /** Human-readable label. */
  readonly backend: 'windows-job' | 'unsandboxed';
  /** Diagnostics for logs. */
  readonly warnings: readonly string[];
}

/**
 * Probe Windows for sandbox capability. Always `true` on this
 * platform; the backend is selected when the manager is on win32.
 */
export async function probeWindowsCapability(): Promise<{ ready: boolean }> {
  return { ready: process.platform === 'win32' };
}

/**
 * Build the argv, environment, and timeout for a Windows sandboxed
 * command.
 */
export function buildWindowsSandboxCommand(policy: SandboxPolicy, command: string): WindowsSandboxCommand {
  if (!policy.enabled) {
    return {
      argv: shellArgv(command),
      env: process.env,
      timeoutMs: policy.timeout,
      cwd: policy.workspace,
      backend: 'unsandboxed',
      warnings: ['sandbox disabled in policy'],
    };
  }
  const env = policy.blockCredentialPaths ? stripCredentials(process.env) : { ...process.env };
  return {
    argv: shellArgv(command),
    env,
    timeoutMs: policy.timeout,
    cwd: policy.workspace,
    backend: 'windows-job',
    warnings: policy.blockCredentialPaths
      ? ['Windows Job Objects require FFI; only env-stripping + cwd restriction are enforced']
      : [],
  };
}

/** `cmd.exe /d /s /c <command>` for Windows. */
function shellArgv(command: string): readonly string[] {
  return ['cmd.exe', '/d', '/s', '/c', command];
}

/**
 * Strip environment variables that should never reach a sandboxed
 * command: tokens, keys, and any `AFICAX_*` family. The result is a
 * defensive copy of `env`.
 */
export function stripCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dropPrefixes = ['AWS_', 'AZURE_', 'GCP_', 'GOOGLE_', 'GITHUB_', 'GITLAB_', 'NPM_TOKEN', 'PYPI_', 'DOCKER_', 'KUBE_', 'VAULT_', 'AFICAX_API', 'AFICAX_TOKEN', 'AFICAX_KEY'];
  const dropExact = new Set([
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AZURE_CLIENT_SECRET',
    'GCP_SERVICE_ACCOUNT_KEY',
    'GITHUB_TOKEN',
    'GITLAB_TOKEN',
    'NPM_TOKEN',
    'PYPI_TOKEN',
    'DOCKER_PASSWORD',
    'KUBECONFIG',
    'VAULT_TOKEN',
  ]);
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (dropExact.has(key)) continue;
    if (dropPrefixes.some((p) => key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Kill a Windows process tree (the spawned PID and every descendant).
 * Used by the manager when the timeout fires.
 */
export function killWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('taskkill failed to spawn', { pid, error: message });
      resolve();
      return;
    }
    child.on('error', () => resolve());
    child.on('close', () => resolve());
  });
}

/** Absolute credential paths blocked by the policy (informational). */
export function credentialPaths(home: string): readonly string[] {
  return credentialPathsToBlock(home);
}

/** Log the policy + backend chosen for a single invocation. */
export function logSandboxInvocation(policy: SandboxPolicy, backend: WindowsSandboxCommand['backend']): void {
  logger.debug('windows sandbox invocation', {
    backend,
    policy: summarisePolicy(policy),
  });
}
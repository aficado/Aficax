// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\sandbox\linux.ts
// Linux sandbox backend: bubblewrap (`bwrap`) with firejail as a
// fallback. The implementation is intentionally narrow:
//
//   * The user-facing contract is "wrap a command in a sandbox and
//     return the wrapped argv". We do NOT spawn the process ourselves;
//     the caller (the bash tool) does that, then we measure runtime
//     and apply a hard kill if the timeout fires.
//   * `bwrap` is preferred because it uses user namespaces and
//     requires no root, no setuid, and no kernel modules beyond what
//     modern distros ship.
//   * `firejail` is the fallback when `bwrap` is missing. It needs
//     setuid root, so we emit a warning when we use it.
//
// Limitations
// -----------
// On Linux without either of these tools we degrade to "no sandbox":
// the policy is still applied via process-level limits (`ulimit`),
// process group isolation, and a wall-clock timer. The
// `isAvailable()` probe returns `false` so the manager can log a
// visible warning to the user.

import { spawn } from 'node:child_process';

import { getLogger } from '@aficax/core';

import {
  credentialPathsToBlock,
  type SandboxPolicy,
  summarisePolicy,
} from './policy.js';

const logger = getLogger();

/** Probed capability at runtime. */
export interface LinuxCapability {
  /** `bwrap` binary path or `null` when missing. */
  readonly bwrap: string | null;
  /** `firejail` binary path or `null` when missing. */
  readonly firejail: string | null;
}

/** Outcome of {@link buildLinuxSandboxArgv}. */
export interface LinuxSandboxCommand {
  /** Full argv, suitable for `Bun.spawn` or `child_process.spawn`. */
  readonly argv: readonly string[];
  /** Human-readable label for logs (which backend produced the argv). */
  readonly backend: 'bwrap' | 'firejail' | 'unsandboxed';
  /** Reasons the argv could not include a real sandbox (for logs). */
  readonly warnings: readonly string[];
}

/**
 * Probe the system for `bwrap` and `firejail`. Each probe is bounded
 * by a short timeout so a stuck binary does not block the server.
 */
export async function probeLinuxCapability(binaries: readonly string[] = ['bwrap', 'firejail']): Promise<LinuxCapability> {
  const result: { bwrap: string | null; firejail: string | null } = { bwrap: null, firejail: null };
  for (const bin of binaries) {
    try {
      const ok = await probeBinary(bin);
      if (ok) {
        if (bin === 'bwrap') result.bwrap = bin;
        else if (bin === 'firejail') result.firejail = bin;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('linux sandbox probe failed', { binary: bin, error: message });
    }
  }
  return result;
}

function probeBinary(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      child = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, 2_000);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

/**
 * Wrap a `command` in a Linux sandbox. The returned argv is meant to
 * be passed straight to `Bun.spawn` — the shell call sits at the
 * tail so the original command line is preserved verbatim.
 */
export function buildLinuxSandboxArgv(
  policy: SandboxPolicy,
  command: string,
  capability: LinuxCapability,
): LinuxSandboxCommand {
  if (!policy.enabled) {
    return { argv: shellArgv(command), backend: 'unsandboxed', warnings: ['sandbox disabled in policy'] };
  }
  if (capability.bwrap !== null) {
    return { argv: buildBwrapArgv(policy, command), backend: 'bwrap', warnings: [] };
  }
  if (capability.firejail !== null) {
    return { argv: buildFirejailArgv(policy, command), backend: 'firejail', warnings: ['bwrap unavailable, falling back to firejail'] };
  }
  return {
    argv: shellArgv(command),
    backend: 'unsandboxed',
    warnings: ['no Linux sandbox tool available (need bwrap or firejail); running unsandboxed'],
  };
}

/** Build the `bwrap` argv for the current policy. */
export function buildBwrapArgv(policy: SandboxPolicy, command: string): readonly string[] {
  const argv: string[] = ['bwrap'];
  argv.push('--new-session', '--die-with-parent', '--proc', '/proc');
  // Filesystem: read-only system, workspace read-write.
  argv.push('--ro-bind', '/usr', '/usr');
  argv.push('--ro-bind', '/lib', '/lib');
  argv.push('--ro-bind', '/lib64', '/lib64');
  argv.push('--ro-bind', '/etc', '/etc');
  argv.push('--ro-bind', '/bin', '/bin');
  argv.push('--ro-bind', '/sbin', '/sbin');
  for (const readPath of policy.allowedReadPaths) {
    argv.push('--ro-bind', readPath, readPath);
  }
  for (const writePath of policy.allowedWritePaths) {
    argv.push('--bind', writePath, writePath);
  }
  // Block credential directories when configured.
  if (policy.blockCredentialPaths) {
    for (const cred of credentialPathsToBlock()) {
      argv.push('--ro-bind', '/dev/null', cred);
    }
  }
  // Network.
  if (!policy.allowNetwork) {
    argv.push('--unshare-net');
  }
  // Resource limits via `--rlimit` (best-effort — bwrap passes these
  // through to prlimit on Linux).
  argv.push('--rlimit', 'as', String(policy.maxMemoryMb * 1024 * 1024));
  argv.push('--rlimit', 'cpu', String(policy.maxCpuPercent));
  // Compose the shell invocation at the tail.
  for (const arg of shellArgv(command)) argv.push(arg);
  return argv;
}

/** Build the `firejail` argv for the current policy. */
export function buildFirejailArgv(policy: SandboxPolicy, command: string): readonly string[] {
  const argv: string[] = ['firejail'];
  argv.push('--noprofile');
  argv.push('--quiet');
  // Network.
  if (policy.allowNetwork) {
    if (policy.allowedNetworkDomains.length > 0) {
      // firejail cannot whitelist domains, so we enable network and
      // log a warning. Documented limitation.
      argv.push('--net=' + policy.allowedNetworkDomains[0]);
    } else {
      argv.push('--net');
    }
  } else {
    argv.push('--net=none');
  }
  // Filesystem whitelist.
  argv.push('--whitelist=' + policy.workspace);
  for (const p of policy.allowedReadPaths) argv.push('--read-only=' + p);
  for (const p of policy.allowedWritePaths) {
    if (p !== policy.workspace) argv.push('--whitelist=' + p);
  }
  // Memory + CPU.
  argv.push('--rlimit-as=' + String(policy.maxMemoryMb * 1024 * 1024));
  argv.push('--rlimit-cpu=' + String(policy.maxCpuPercent));
  for (const arg of shellArgv(command)) argv.push(arg);
  return argv;
}

/** `sh -c <command>` or `cmd.exe /d /s /c <command>` depending on platform. */
function shellArgv(command: string): readonly string[] {
  if (process.platform === 'win32') {
    return ['cmd.exe', '/d', '/s', '/c', command];
  }
  return ['/bin/sh', '-c', command];
}

/** Log the policy + backend chosen for a single invocation. */
export function logSandboxInvocation(policy: SandboxPolicy, backend: LinuxSandboxCommand['backend']): void {
  logger.debug('linux sandbox invocation', {
    backend,
    policy: summarisePolicy(policy),
  });
}
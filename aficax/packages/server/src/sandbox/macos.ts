// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\sandbox\macos.ts
// macOS sandbox backend: Apple Seatbelt via `sandbox-exec`.
//
// `sandbox-exec` takes a single argument: a Scheme-syntax profile that
// declaratively denies / allows operations. The profile is the
// per-invocation equivalent of `bwrap` flags: we generate it from
// the {@link SandboxPolicy} and pass it via `-` (stdin) so we never
// have to write a temp file.
//
// Limitations
// -----------
// Seatbelt profiles are evaluated top-to-bottom with a last-rule-wins
// semantic, so we emit `deny default` first and then `allow` the
// operations the policy grants. There is no per-domain network
// whitelist; Seatbelt allows IP-level filtering but that is rarely
// what users want, so we keep network either fully on or fully off.

import { spawn } from 'node:child_process';

import { getLogger } from '@aficax/core';

import {
  credentialPathsToBlock,
  type SandboxPolicy,
  summarisePolicy,
} from './policy.js';

const logger = getLogger();

/** Outcome of {@link buildMacSandboxCommand}. */
export interface MacSandboxCommand {
  readonly argv: readonly string[];
  readonly profile: string;
  readonly backend: 'sandbox-exec' | 'unsandboxed';
  readonly warnings: readonly string[];
}

/** Probe whether `sandbox-exec` is on PATH. */
export async function probeMacCapability(): Promise<{ sandboxExec: boolean }> {
  return { sandboxExec: await probeBinary('sandbox-exec') };
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
      child = spawn(bin, ['-h'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(false);
    }, 2_000);
    child.on('error', () => { clearTimeout(timer); finish(false); });
    child.on('close', (code) => { clearTimeout(timer); finish(code === 0 || code === 1); });
  });
}

/**
 * Wrap a `command` in a macOS Seatbelt sandbox. When `policy.enabled`
 * is `false` or `sandbox-exec` is missing, returns an unsandboxed
 * shell argv with a warning.
 */
export function buildMacSandboxCommand(
  policy: SandboxPolicy,
  command: string,
  capability: { sandboxExec: boolean },
): MacSandboxCommand {
  if (!policy.enabled) {
    return {
      argv: shellArgv(command),
      profile: '',
      backend: 'unsandboxed',
      warnings: ['sandbox disabled in policy'],
    };
  }
  if (!capability.sandboxExec) {
    return {
      argv: shellArgv(command),
      profile: '',
      backend: 'unsandboxed',
      warnings: ['sandbox-exec not available; running unsandboxed'],
    };
  }
  const profile = renderProfile(policy);
  return {
    argv: ['sandbox-exec', '-p', profile, '/bin/sh', '-c', command],
    profile,
    backend: 'sandbox-exec',
    warnings: [],
  };
}

/** Render a Seatbelt Scheme profile from the current policy. */
export function renderProfile(policy: SandboxPolicy): string {
  const lines: string[] = [];
  lines.push(';; Aficax sandbox profile (generated; do not edit by hand)');
  lines.push('(version 1)');
  lines.push('(deny default)');
  // Allow process basics.
  lines.push('(allow process-exec)');
  lines.push('(allow process-fork)');
  lines.push('(allow signal)');
  lines.push('(allow sysctl-read)');
  lines.push('(allow mach-lookup)');
  lines.push('(allow sysctl-read-namespaced)');
  // File system: read-only system, read-write workspace.
  lines.push('(allow file-read*)');
  lines.push('(allow file-read-metadata)');
  for (const writePath of policy.allowedWritePaths) {
    lines.push(`(allow file-write* (subpath "${writePath}"))`);
    lines.push(`(allow file-write-create (subpath "${writePath}"))`);
  }
  for (const readPath of policy.allowedReadPaths) {
    lines.push(`(allow file-read* (subpath "${readPath}"))`);
  }
  // Block credential paths explicitly when requested.
  if (policy.blockCredentialPaths) {
    for (const cred of credentialPathsToBlock()) {
      lines.push(`(deny file-read* (subpath "${cred}"))`);
      lines.push(`(deny file-read-metadata (subpath "${cred}"))`);
    }
  }
  // Network.
  if (policy.allowNetwork) {
    lines.push('(allow network*)');
  } else {
    lines.push('(deny network*)');
  }
  return lines.join('\n');
}

/** `sh -c <command>` for macOS. */
function shellArgv(command: string): readonly string[] {
  return ['/bin/sh', '-c', command];
}

/** Log the policy + backend chosen for a single invocation. */
export function logSandboxInvocation(policy: SandboxPolicy, backend: MacSandboxCommand['backend']): void {
  logger.debug('macos sandbox invocation', {
    backend,
    policy: summarisePolicy(policy),
  });
}
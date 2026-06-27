// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\sandbox\index.ts
// SandboxManager: cross-platform facade that picks the right backend
// for the host OS, runs the wrapped command, and reports a uniform
// {@link SandboxResult} regardless of which backend was used.
//
// Lifecycle:
//   1. Constructor takes the {@link SandboxPolicy} (or a default).
//   2. `init()` probes the host for the right tools and caches the
//      capability. Safe to call multiple times.
//   3. `execute()` builds the wrapped argv for the current policy +
//      backend, spawns the process, applies the timeout, and collects
//      stdout / stderr / exit code.
//
// Failure modes
// -------------
// * Sandbox disabled → command runs without wrapping. A warning is
//   logged so the operator can see why.
// * OS backend missing → same as above. The `unsandboxed` label is
//   surfaced in the result so callers can decide what to do.

import { spawn } from 'node:child_process';

import { getLogger } from '@aficax/core';

import {
  buildLinuxSandboxArgv,
  probeLinuxCapability,
  type LinuxCapability,
  type LinuxSandboxCommand,
} from './linux.js';
import {
  buildMacSandboxCommand,
  probeMacCapability,
  type MacSandboxCommand,
} from './macos.js';
import {
  type SandboxPolicy,
  defaultSandboxPolicy,
  mergeSandboxPolicy,
  summarisePolicy,
  validateSandboxPolicy,
} from './policy.js';
import {
  buildWindowsSandboxCommand,
  killWindowsProcessTree,
  probeWindowsCapability,
  type WindowsSandboxCommand,
} from './windows.js';

const logger = getLogger();

/** Discriminated union of every backend's command payload. */
export type BackendCommand =
  | { readonly kind: 'linux'; readonly cmd: LinuxSandboxCommand; readonly capability: LinuxCapability }
  | { readonly kind: 'macos'; readonly cmd: MacSandboxCommand; readonly capability: { sandboxExec: boolean } }
  | { readonly kind: 'windows'; readonly cmd: WindowsSandboxCommand; readonly capability: { ready: boolean } };

/** Result returned by {@link SandboxManager.execute}. */
export interface SandboxResult {
  /** `true` when the command actually ran inside a sandbox. */
  readonly sandboxed: boolean;
  /** Backend label (`bwrap`, `firejail`, `sandbox-exec`, `windows-job`, `unsandboxed`). */
  readonly backend: string;
  /** Captured stdout. */
  readonly stdout: string;
  /** Captured stderr. */
  readonly stderr: string;
  /** Exit code (`-1` when the process was killed before exiting). */
  readonly exitCode: number;
  /** Wall-clock duration in ms. */
  readonly durationMs: number;
  /** `true` when the command was killed because of a timeout. */
  readonly timedOut: boolean;
  /** Warnings emitted by the backend (credentials-blocked, fallback used, ...). */
  readonly warnings: readonly string[];
}

/** Configuration accepted by {@link SandboxManager}. */
export interface SandboxManagerOptions {
  /** Policy to enforce. Defaults to {@link defaultSandboxPolicy}. */
  readonly policy?: SandboxPolicy;
  /** Override the home directory used for credential paths (tests). */
  readonly homeDir?: string;
  /** Override the spawn function (tests). Defaults to `child_process.spawn`. */
  readonly spawn?: typeof spawn;
}

/**
 * Detect the host OS and pick the matching backend. Always returns a
 * working manager — when the right tools are missing, the manager
 * falls back to running the command unsandboxed with a warning.
 */
export class SandboxManager {
  private readonly homeDir: string;
  private readonly spawnFn: typeof spawn;
  private policy: SandboxPolicy;
  private linuxCap: LinuxCapability = { bwrap: null, firejail: null };
  private macCap: { sandboxExec: boolean } = { sandboxExec: false };
  private windowsCap: { ready: boolean } = { ready: false };
  private initialised = false;

  constructor(options: SandboxManagerOptions = {}) {
    this.policy = options.policy ?? defaultSandboxPolicy(options.homeDir);
    this.homeDir = options.homeDir ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
    this.spawnFn = options.spawn ?? spawn;
  }

  /** Current policy. */
  get currentPolicy(): SandboxPolicy {
    return this.policy;
  }

  /** Replace the policy; merges onto the existing one. */
  setPolicy(overrides: Partial<SandboxPolicy>): void {
    this.policy = mergeSandboxPolicy(this.policy, overrides);
  }

  /** Human-readable label for the active OS. */
  get platform(): NodeJS.Platform {
    return process.platform;
  }

  /** Run capability probes. Idempotent. */
  async init(): Promise<void> {
    if (process.platform === 'linux') {
      this.linuxCap = await probeLinuxCapability();
    } else if (process.platform === 'darwin') {
      this.macCap = await probeMacCapability();
    } else if (process.platform === 'win32') {
      this.windowsCap = await probeWindowsCapability();
    }
    this.initialised = true;
    logger.info('sandbox initialised', {
      platform: process.platform,
      ...this.capabilitySummary(),
    });
  }

  /**
   * Probe whether the active backend is "fully usable". Returns `true`
   * when the policy is enabled AND the OS backend is available.
   * Returns `false` when the policy is disabled OR the backend is
   * missing.
   */
  async isAvailable(): Promise<boolean> {
    if (!this.initialised) await this.init();
    if (!this.policy.enabled) return false;
    if (process.platform === 'linux') return this.linuxCap.bwrap !== null || this.linuxCap.firejail !== null;
    if (process.platform === 'darwin') return this.macCap.sandboxExec;
    if (process.platform === 'win32') return this.windowsCap.ready;
    return false;
  }

  /** Run `command` through the active backend. */
  async execute(command: string, options: { readonly cwd?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): Promise<SandboxResult> {
    if (!this.initialised) await this.init();
    const errors = validateSandboxPolicy(this.policy);
    if (errors.length > 0) {
      return this.unsandboxedResult(command, errors.join('; '), options);
    }
    const backend = this.buildBackend(command, options.cwd ?? this.policy.workspace);
    const timeoutMs = options.timeoutMs ?? this.policy.timeout;
    const startedAt = Date.now();
    const child = this.spawnChild(backend);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.killTree(child);
    }, Math.max(1, timeoutMs));
    options.signal?.addEventListener('abort', () => {
      timedOut = true;
      this.killTree(child);
    }, { once: true });

    let stdout = '';
    let stderr = '';
    let exitCode = -1;
    try {
      const [rawOut, rawErr, code] = await Promise.all([
        readStream(child.stdout),
        readStream(child.stderr),
        new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1))),
      ]);
      stdout = rawOut;
      stderr = rawErr;
      exitCode = code;
    } finally {
      clearTimeout(timer);
    }
    const warnings = backend.kind === 'linux'
      ? backend.cmd.warnings
      : backend.kind === 'macos'
        ? backend.cmd.warnings
        : backend.cmd.warnings;
    logger.debug('sandbox command finished', {
      backend: backendLabel(backend),
      durationMs: Date.now() - startedAt,
      exitCode,
      timedOut,
      warnings,
    });
    return {
      sandboxed: this.isSandboxed(backend),
      backend: backendLabel(backend),
      stdout,
      stderr,
      exitCode,
      durationMs: Date.now() - startedAt,
      timedOut,
      warnings,
    };
  }

  /** Build the backend command for the current OS. Public for tests. */
  buildBackend(command: string, cwd: string): BackendCommand {
    if (process.platform === 'linux') {
      const cmd = buildLinuxSandboxArgv(this.policy, command, this.linuxCap);
      return { kind: 'linux', cmd, capability: this.linuxCap };
    }
    if (process.platform === 'darwin') {
      const cmd = buildMacSandboxCommand(this.policy, command, this.macCap);
      return { kind: 'macos', cmd, capability: this.macCap };
    }
    if (process.platform === 'win32') {
      const cmd = buildWindowsSandboxCommand(this.policy, command);
      return { kind: 'windows', cmd, capability: this.windowsCap };
    }
    // Unknown platform — fall back to a plain shell.
    void cwd;
    return {
      kind: 'windows',
      cmd: {
        argv: ['/bin/sh', '-c', command],
        env: process.env,
        timeoutMs: this.policy.timeout,
        cwd,
        backend: 'unsandboxed',
        warnings: [`unsupported platform: ${process.platform}`],
      },
      capability: { ready: false },
    };
  }

  // -- Internals ---------------------------------------------------------

  private spawnChild(backend: BackendCommand): ReturnType<typeof spawn> {
    if (backend.kind === 'windows') {
      return this.spawnFn(backend.cmd.argv[0] ?? 'cmd.exe', backend.cmd.argv.slice(1), {
        cwd: backend.cmd.cwd,
        env: backend.cmd.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    }
    return this.spawnFn(backend.cmd.argv[0] ?? '/bin/sh', backend.cmd.argv.slice(1), {
      cwd: this.policy.workspace,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  private killTree(child: ReturnType<typeof spawn>): void {
    if (process.platform === 'win32' && child.pid !== undefined) {
      void killWindowsProcessTree(child.pid);
      return;
    }
    try {
      child.kill('SIGKILL');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('kill raised', { error: message });
    }
  }

  private isSandboxed(backend: BackendCommand): boolean {
    if (backend.kind === 'linux') return backend.cmd.backend === 'bwrap' || backend.cmd.backend === 'firejail';
    if (backend.kind === 'macos') return backend.cmd.backend === 'sandbox-exec';
    if (backend.kind === 'windows') return backend.cmd.backend === 'windows-job';
    return false;
  }

  private capabilitySummary(): Record<string, unknown> {
    if (process.platform === 'linux') {
      return { bwrap: this.linuxCap.bwrap !== null, firejail: this.linuxCap.firejail !== null };
    }
    if (process.platform === 'darwin') {
      return { sandboxExec: this.macCap.sandboxExec };
    }
    if (process.platform === 'win32') {
      return { jobObjects: this.windowsCap.ready };
    }
    return { unsupported: true };
  }

  private unsandboxedResult(command: string, reason: string, options: { readonly timeoutMs?: number; readonly signal?: AbortSignal }): Promise<SandboxResult> {
    logger.warn('sandbox: invalid policy; running unsandboxed', { reason });
    return this.execute(command, options).then((r) => ({
      ...r,
      sandboxed: false,
      backend: 'unsandboxed',
      warnings: [...r.warnings, `policy invalid: ${reason}`],
    }));
  }
}

// -- Helpers --------------------------------------------------------------

function backendLabel(backend: BackendCommand): string {
  if (backend.kind === 'linux') return backend.cmd.backend;
  if (backend.kind === 'macos') return backend.cmd.backend;
  if (backend.kind === 'windows') return backend.cmd.backend;
  return 'unsandboxed';
}

function readStream(stream: NodeJS.ReadableStream | null | undefined): Promise<string> {
  if (stream === null || stream === undefined) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer | string) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : chunk);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    stream.on('error', () => resolve(''));
  });
}

/** Factory that creates a {@link SandboxManager} with the default policy. */
export function createSandboxManager(options: SandboxManagerOptions = {}): SandboxManager {
  return new SandboxManager(options);
}

/** Convenience: read the current status as a plain object. */
export async function sandboxStatus(manager: SandboxManager): Promise<{
  platform: NodeJS.Platform;
  enabled: boolean;
  available: boolean;
  backend: string;
  warnings: readonly string[];
  policySummary: string;
}> {
  const available = await manager.isAvailable();
  const probeBackend = manager.buildBackend('echo probe', manager.currentPolicy.workspace);
  const warnings = probeBackend.kind === 'linux'
    ? probeBackend.cmd.warnings
    : probeBackend.kind === 'macos'
      ? probeBackend.cmd.warnings
      : probeBackend.cmd.warnings;
  return {
    platform: manager.platform,
    enabled: manager.currentPolicy.enabled,
    available,
    backend: backendLabel(probeBackend),
    warnings,
    policySummary: summarisePolicy(manager.currentPolicy),
  };
}
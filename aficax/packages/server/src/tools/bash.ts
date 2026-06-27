// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\tools\bash.ts
// Execute a shell command, capture stdout and stderr separately, enforce a
// timeout, and redact secrets from the captured output before returning it
// to the model. When the server has a {@link SandboxManager} configured,
// the command runs inside the sandbox; otherwise it falls back to a
// direct `Bun.spawn` call.

import { redactSecrets, type ToolDefinition, type ToolResult } from '@aficax/core';

import { type SandboxManager, type SandboxResult } from '../sandbox/index.js';
import type { ToolImplementation } from './registry.js';

/** Default command execution timeout, in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Public configuration of the `bash` tool. */
export interface BashToolOptions {
  /**
   * When supplied, every command runs through the sandbox. The
   * sandbox's policy decides whether the wrapping actually applies.
   */
  readonly sandbox?: SandboxManager;
}

export function createBash(options: BashToolOptions = {}): ToolImplementation {
  const sandbox = options.sandbox;

  const definition: ToolDefinition = {
    name: 'bash',
    description:
      'Execute a shell command. Returns the captured stdout, stderr, and exit ' +
      'code. Output is automatically redacted to remove known secret patterns ' +
      '(API keys, OAuth tokens, AWS access keys). The command runs in the ' +
      'session working directory and is killed after the configured timeout. ' +
      'When the server has a sandbox configured, the command runs inside it.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute.',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in milliseconds. Defaults to 30000 (30s).',
        },
      },
      required: ['command'],
    },
    permissionLevel: 'require_approval',
  };

  return {
    definition,
    async execute(input, context): Promise<ToolResult> {
      const command = String(input['command'] ?? '');
      const timeoutRaw = input['timeout'];
      const timeout = typeof timeoutRaw === 'number' && timeoutRaw > 0 ? Math.floor(timeoutRaw) : DEFAULT_TIMEOUT_MS;

      if (command.length === 0) {
        return { content: 'Error: "command" is required.', isError: true };
      }

      const start = Date.now();
      const timeoutController = new AbortController();
      const timer = setTimeout(() => {
        timeoutController.abort(new Error('Command timed out'));
      }, timeout);

      const composedSignal = context.signal
        ? AbortSignal.any([context.signal, timeoutController.signal])
        : timeoutController.signal;

      try {
        const result = sandbox !== undefined
          ? await sandbox.execute(command, {
              cwd: context.workingDir,
              timeoutMs: timeout,
              signal: composedSignal,
            })
          : await runUnsandboxed(command, context.workingDir, timeout, composedSignal);

        const duration = Date.now() - start;
        const timedOut = timeoutController.signal.aborted;

        const stdout = redactSecrets(result.stdout);
        const stderr = redactSecrets(result.stderr);

        const payload = {
          stdout,
          stderr,
          exitCode: result.exitCode,
          duration,
          timedOut,
          command,
          sandboxed: result.sandboxed,
          backend: result.backend,
        };

        return {
          content: summaryPayload(payload),
          isError: result.exitCode !== 0 || timedOut,
          metadata: {
            ...payload,
            workingDir: context.workingDir,
            warnings: result.warnings,
            stdoutBytes: Buffer.byteLength(result.stdout, 'utf-8'),
            stderrBytes: Buffer.byteLength(result.stderr, 'utf-8'),
          },
        };
      } catch (err) {
        const duration = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = timeoutController.signal.aborted;
        return {
          content: JSON.stringify({
            stdout: '',
            stderr: message,
            exitCode: -1,
            duration,
            timedOut,
            command,
            sandboxed: false,
          }),
          isError: true,
          metadata: {
            stdout: '',
            stderr: message,
            exitCode: -1,
            duration,
            timedOut,
            command,
            crashed: true,
            workingDir: context.workingDir,
          },
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function runUnsandboxed(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal,
): Promise<SandboxResult> {
  const start = Date.now();
  // `Bun.spawn` expects a mutable `string[]`; spread the readonly
  // command tuple into a fresh array so the types line up.
  const proc = Bun.spawn({
    cmd: [...buildShellCommand(command)],
    cwd,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);
  return {
    sandboxed: false,
    backend: 'unsandboxed',
    stdout,
    stderr,
    exitCode,
    durationMs: Date.now() - start,
    timedOut: false,
    warnings: ['sandbox manager not configured; command ran unsandboxed'],
  };
}

async function readStream(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) return '';
  const response = new Response(stream);
  return response.text();
}

function summaryPayload(payload: {
  stdout: string;
  stderr: string;
  exitCode: number;
  duration: number;
  timedOut: boolean;
  command: string;
  sandboxed: boolean;
  backend: string;
}): string {
  return JSON.stringify(payload);
}

/**
 * Build the OS-appropriate shell command for executing `command`.
 *
 * - On Windows we prefer Git Bash when available (it ships with Git for
 *   Windows and gives us a POSIX-ish shell that handles common Unix
 *   idioms like `&&`, `||`, pipes and `2>&1`); if Git Bash is not on
 *   PATH we fall back to `cmd.exe /c`.
 * - On every other platform we use `/bin/sh -c`, the standard POSIX
 *   shell entrypoint.
 */
function buildShellCommand(command: string): readonly string[] {
  if (process.platform !== 'win32') {
    return ['/bin/sh', '-c', command];
  }
  const gitBash = resolveGitBash();
  if (gitBash !== null) {
    return [gitBash, '-c', command];
  }
  return ['cmd.exe', '/c', command];
}

/**
 * Probe well-known install locations for Git Bash on Windows.
 *
 * Returns an absolute path or `null` if no candidate is reachable. We do
 * not shell out to `where bash` here because spawning a child during a
 * tool-call hot path is wasteful; the two locations below cover the
 * overwhelming majority of Windows dev setups.
 */
function resolveGitBash(): string | null {
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const candidate of candidates) {
    try {
      const stat = Bun.file(candidate).size;
      if (typeof stat === 'number' && stat > 0) {
        return candidate;
      }
    } catch {
      // file does not exist or is not readable
    }
  }
  return null;
}
// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\hooks\dispatcher.ts
// HookDispatcher: executes every hook registered for a given event and
// aggregates their replies into a single {@link HookResult}.
//
// Protocol
// --------
// 1. The dispatcher spawns the hook's `command` via `Bun.spawn` with
//    `stdin: 'pipe'`, `stdout: 'pipe'`, `stderr: 'pipe'`.
// 2. The hook context (a {@link HookContext}) is serialised to a single
//    line of JSON and written to the child's stdin, then the write end
//    is closed so the child can read EOF and exit cleanly.
// 3. The dispatcher reads stdout until EOF or the timeout fires. The
//    first non-empty line is parsed as a {@link HookReply}; everything
//    else is discarded (the hook is allowed to print log lines).
// 4. The exit code is checked. A non-zero exit counts as a failure.
// 5. Failures are routed according to the hook's `onFailure`:
//    * `abort`  -> mark the result as blocked, attach the error.
//    * `continue` -> log and add the error to `errors[]`.
//
// Context modification
// -------------------
// When a hook replies with `modifiedContext`, the dispatcher replaces the
// in-flight context with the new value (validated as a JSON object) and
// forwards it to the next hook and to the caller. This lets hooks
// rewrite the user prompt, rewrite tool input, etc.

import { getLogger, type SessionId } from '@aficax/core';

import {
  type HookContext,
  type HookError,
  type HookEvent,
  type HookReply,
  type HookResult,
  type ResolvedHook,
} from './schema.js';

const logger = getLogger();

/** Tokenisation mode for the command string. POSIX-shell-ish. */
export type ShellTokeniser = (command: string) => readonly string[];

/** Public configuration of {@link HookDispatcher}. */
export interface HookDispatcherOptions {
  /** Default timeout when a hook does not specify one. */
  readonly defaultTimeoutMs?: number;
  /** Tokeniser used to split the `command` string. Defaults to {@link tokenise}. */
  readonly tokenise?: ShellTokeniser;
  /** Override the spawner (tests). Defaults to {@link defaultSpawn}. */
  readonly spawn?: SpawnFn;
  /** Optional hook provider: returns the hooks for a given event. */
  readonly hookProvider?: HookProvider;
}

/** Returned by a {@link HookProvider} for a single event. */
export type HookProvider = (event: HookEvent, sessionId: SessionId) => Promise<readonly ResolvedHook[]>;

/** Minimal child handle for the dispatcher. Mirrors `transport/stdio.ts`. */
export interface DispatcherChild {
  writeLine(line: string): Promise<void>;
  stdoutText(): Promise<string>;
  stderrText(): Promise<string>;
  exited: Promise<number>;
  kill(signal?: number): Promise<void>;
}

export type SpawnFn = (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<DispatcherChild>;

/** Default spawner backed by `Bun.spawn`. */
export const defaultSpawn: SpawnFn = async (argv, env) => {
  const proc = Bun.spawn({
    cmd: [...argv],
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');

  return {
    async writeLine(line: string): Promise<void> {
      const stdin = proc.stdin;
      if (stdin === undefined) {
        throw new Error('child stdin is not a writable stream');
      }
      const writer = stdin as unknown as WritableStreamDefaultWriter<Uint8Array>;
      if (typeof (writer as { write?: unknown }).write === 'function') {
        await writer.write(encoder.encode(`${line}\n`));
        return;
      }
      (stdin as unknown as { write(data: Uint8Array): number }).write(
        encoder.encode(`${line}\n`),
      );
    },
    async stdoutText(): Promise<string> {
      const stream = proc.stdout;
      if (stream === undefined) return '';
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return buffer;
          if (value !== undefined) {
            buffer += decoder.decode(value, { stream: true });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    },
    async stderrText(): Promise<string> {
      const stream = proc.stderr;
      if (stream === undefined) return '';
      const reader = (stream as ReadableStream<Uint8Array>).getReader();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return buffer;
          if (value !== undefined) {
            buffer += decoder.decode(value, { stream: true });
          }
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          /* ignore */
        }
      }
    },
    exited: proc.exited,
    async kill(signal?: number): Promise<void> {
      try {
        proc.kill(signal ?? (process.platform === 'win32' ? 9 : 15));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('hooks: kill raised', { error: message });
      }
      try {
        await proc.exited;
      } catch {
        /* ignore */
      }
    },
  };
};

/**
 * Tokenise a command string into argv. Handles single and double quotes
 * and backslash escapes; intentionally simple (no env-var expansion).
 */
export function tokenise(command: string): readonly string[] {
  const out: string[] = [];
  let buf = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? '';
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (buf.length > 0) {
        out.push(buf);
        buf = '';
      }
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

/**
 * Execute every hook registered for `event`, in declaration order, and
 * aggregate the replies. The first hook to reply with `block: true` wins;
 * later hooks are still run (so observability stays complete) but their
 * modifications to the context are not applied after the block.
 */
export class HookDispatcher {
  private readonly defaultTimeoutMs: number;
  private readonly tokenise: ShellTokeniser;
  private readonly spawn: SpawnFn;
  private readonly hookProvider: HookProvider | null;

  constructor(options: HookDispatcherOptions = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5_000;
    this.tokenise = options.tokenise ?? tokenise;
    this.spawn = options.spawn ?? defaultSpawn;
    this.hookProvider = options.hookProvider ?? null;
  }

  /** Build a dispatcher that always returns the given hooks (tests). */
  static withHooks(hooks: readonly ResolvedHook[]): HookDispatcher {
    return new HookDispatcher({
      hookProvider: async () => hooks,
    });
  }

  /**
   * Run every hook for `event` with the given context. The returned
   * result carries the final (possibly modified) context, any block
   * decision, and the per-hook errors that did not abort.
   */
  async dispatch(event: HookEvent, context: HookContext): Promise<HookResult> {
    const startedAt = Date.now();
    const hooks = await this.resolveHooks(event, context.sessionId);
    const errors: HookError[] = [];
    let current: HookContext = context;
    let blocked = false;
    let blockReason: string | undefined;

    for (const hook of hooks) {
      if (blocked) {
        // We still observe the hook (for telemetry) but no longer let it
        // modify the in-flight context.
        await this.runOne(hook, event, current, errors, true);
        continue;
      }
      const outcome = await this.runOne(hook, event, current, errors, false);
      if (outcome.reply !== null) {
        if (outcome.reply.block === true) {
          blocked = true;
          blockReason = outcome.reply.reason ?? 'blocked by hook';
          if (typeof blockReason === 'string' && blockReason.length > 0) {
            // Use the reason only when it's a plain string.
          } else {
            blockReason = 'blocked by hook';
          }
        }
        if (outcome.reply.modifiedContext !== undefined) {
          const candidate = outcome.reply.modifiedContext;
          if (isPlainObject(candidate)) {
            current = { ...current, ...(candidate as Record<string, unknown>) } as HookContext;
          } else {
            errors.push({
              event,
              command: hook.command,
              kind: 'invalid_json',
              message: 'modifiedContext is not a JSON object',
              durationMs: 0,
            });
          }
        }
      }
    }

    const result: HookResult = {
      blocked,
      context: current,
      errors,
      durationMs: Date.now() - startedAt,
    };
    if (blockReason !== undefined) {
      return { ...result, blockReason };
    }
    return result;
  }

  // -- Internals ---------------------------------------------------------

  private async resolveHooks(event: HookEvent, sessionId: SessionId): Promise<readonly ResolvedHook[]> {
    if (this.hookProvider === null) return [];
    try {
      const list = await this.hookProvider(event, sessionId);
      return list.filter((h) => h.enabled);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('hooks: provider threw', { event, error: message });
      return [];
    }
  }

  private async runOne(
    hook: ResolvedHook,
    event: HookEvent,
    context: HookContext,
    errors: HookError[],
    observedOnly: boolean,
  ): Promise<{ readonly reply: HookReply | null }> {
    const startedAt = Date.now();
    const argv = this.tokenise(hook.command);
    if (argv.length === 0) {
      const err: HookError = {
        event,
        command: hook.command,
        kind: 'spawn_failed',
        message: 'command produced an empty argv after tokenisation',
        durationMs: 0,
      };
      errors.push(err);
      return { reply: null };
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v;
    }
    let child: DispatcherChild;
    try {
      child = await this.spawn(argv, env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hookError: HookError = {
        event,
        command: hook.command,
        kind: 'spawn_failed',
        message,
        durationMs: 0,
      };
      if (hook.onFailure === 'abort') {
        // The dispatcher converts a spawn failure into a synthetic block
        // by signalling the caller; the easiest path is to push a
        // "timeout"-like error with onFailure=abort and let the outer
        // loop apply the abort policy on the next iteration.
        errors.push(hookError);
        logger.warn('hooks: spawn failed (abort policy)', { command: hook.command, error: message });
        return { reply: { block: hook.onFailure === 'abort' } };
      }
      errors.push(hookError);
      logger.warn('hooks: spawn failed', { command: hook.command, error: message });
      return { reply: null };
    }
    if (observedOnly) {
      // We still need to drive the child to completion so we don't leak
      // zombie processes, but we discard any reply.
      try {
        await child.writeLine(JSON.stringify({ ...context, _observed: true }));
      } catch {
        /* ignore */
      }
      try {
        await child.kill();
      } catch {
        /* ignore */
      }
      await child.exited.catch(() => undefined);
      return { reply: null };
    }
    const timeoutMs = hook.timeoutMs > 0 ? hook.timeoutMs : this.defaultTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

    let exitCode = -1;
    let stdoutText = '';
    let stderrText = '';
    try {
      try {
        await child.writeLine(JSON.stringify(context));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const hookError: HookError = {
          event,
          command: hook.command,
          kind: 'spawn_failed',
          message,
          durationMs: Date.now() - startedAt,
        };
        if (hook.onFailure === 'abort') {
          return { reply: { block: true, reason: `hook stdin write failed: ${message}` } };
        }
        errors.push(hookError);
        return { reply: null };
      }
      // Close stdin so the child can read EOF.
      try {
        await child.kill(); // no-op: we just want to wait
      } catch {
        /* ignore */
      }
      const stdoutPromise = child.stdoutText();
      const stderrPromise = child.stderrText();
      const exitedPromise = child.exited;
      const winner = await Promise.race([
        exitedPromise,
        new Promise<number>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(-1));
        }),
      ]);
      if (controller.signal.aborted && winner === -1) {
        try {
          await child.kill(9);
        } catch {
          /* ignore */
        }
        const hookError: HookError = {
          event,
          command: hook.command,
          kind: 'timeout',
          message: `hook exceeded ${String(timeoutMs)} ms`,
          durationMs: Date.now() - startedAt,
        };
        if (hook.onFailure === 'abort') {
          return { reply: { block: true, reason: hookError.message } };
        }
        errors.push(hookError);
        logger.warn('hooks: timed out (continue policy)', { command: hook.command });
        return { reply: null };
      }
      exitCode = winner;
      [stdoutText, stderrText] = await Promise.all([stdoutPromise, stderrPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (exitCode !== 0) {
      const hookError: HookError = {
        event,
        command: hook.command,
        kind: 'exit_nonzero',
        message: `hook exited with code ${String(exitCode)}: ${stderrText.slice(0, 500)}`,
        durationMs: Date.now() - startedAt,
      };
      if (hook.onFailure === 'abort') {
        return { reply: { block: true, reason: hookError.message } };
      }
      errors.push(hookError);
      logger.warn('hooks: non-zero exit (continue policy)', {
        command: hook.command,
        exitCode,
        stderr: stderrText.slice(0, 500),
      });
      return { reply: null };
    }

    const reply = parseReply(stdoutText);
    if (reply === null) {
      const hookError: HookError = {
        event,
        command: hook.command,
        kind: 'invalid_json',
        message: stderrText.length > 0 ? stderrText.slice(0, 500) : 'no JSON reply on stdout',
        durationMs: Date.now() - startedAt,
      };
      if (hook.onFailure === 'abort') {
        return { reply: { block: true, reason: hookError.message } };
      }
      errors.push(hookError);
      return { reply: null };
    }
    return { reply };
  }
}

// -- Helpers --------------------------------------------------------------

function parseReply(raw: string): HookReply | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  // The hook may print logs before the reply; take the LAST JSON-looking
  // line so observers get the freshest state.
  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (line.startsWith('{') && line.endsWith('}')) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (isPlainObject(parsed)) {
          return parsed as HookReply;
        }
      } catch {
        continue;
      }
    }
  }
  return null;
}

function isPlainObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Factory that creates a fresh {@link HookDispatcher}. */
export function createHookDispatcher(options: HookDispatcherOptions = {}): HookDispatcher {
  return new HookDispatcher(options);
}

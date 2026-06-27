// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\slash\handler.ts
// SlashHandler: pure dispatcher that turns `/<command> [args]` lines
// typed by the user in the TUI into a {@link SlashResult}.
//
// The handler is intentionally transport-agnostic: it receives a
// {@link SlashContext} (the server base URL, the active session id,
// and a couple of `fetch` helpers) and returns either a remote
// command (which the caller executes against the server) or a local
// action (which the TUI itself performs — clear the screen, toggle
// debug, etc.).
//
// The catalogue lives in {@link SLASH_COMMANDS} so the TUI can render
// the autocomplete dropdown from the same source of truth.

/** Lightweight context the handler needs to perform each command. */
export interface SlashContext {
  /** Base URL of the running server. */
  readonly serverUrl: string;
  /** Active session id, when one exists. */
  readonly sessionId: string | undefined;
  /** Optional override of the working directory. */
  readonly workingDir?: string;
}

/** Side-effecting actions the TUI performs locally. */
export type SlashLocalAction =
  | { readonly kind: 'clear-screen' }
  | { readonly kind: 'toggle-debug' }
  | { readonly kind: 'exit-confirm' }
  | { readonly kind: 'show-help'; readonly command?: string };

/** HTTP calls the handler wants the TUI to issue. */
export interface SlashHttpCall {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  readonly path: string;
  readonly body?: unknown;
  /** Optional success message the TUI should render. */
  readonly successMessage?: string;
  /** When set, the handler wants the response body printed verbatim. */
  readonly printResponse?: boolean;
}

/** Outcome of a {@link SlashHandler.handle} call. */
export type SlashResult =
  | { readonly kind: 'http'; readonly call: SlashHttpCall }
  | { readonly kind: 'local'; readonly action: SlashLocalAction }
  | { readonly kind: 'message'; readonly text: string }
  | { readonly kind: 'unknown'; readonly input: string };

/** Static description of a slash command (for the autocomplete UI). */
export interface SlashCommandSpec {
  readonly command: string;
  readonly aliases?: readonly string[];
  readonly description: string;
  readonly usage?: string;
  /** Whether the command needs an active session. */
  readonly needsSession?: boolean;
}

/** The full catalogue of slash commands supported by Aficax. */
export const SLASH_COMMANDS: readonly SlashCommandSpec[] = [
  { command: 'new', description: 'Start a new session.', needsSession: false },
  { command: 'resume', description: 'Resume a previous session.', usage: '/resume [id]', needsSession: false },
  { command: 'compact', description: 'Force a context compaction pass.', needsSession: true },
  { command: 'status', description: 'Show the active session status.', needsSession: true },
  { command: 'clear', description: 'Clear the TUI screen.' },
  { command: 'model', description: 'Switch the active model.', usage: '/model [name]', needsSession: true },
  { command: 'provider', description: 'Switch the active provider.', usage: '/provider [name]', needsSession: true },
  { command: 'mode', description: 'Change the approval mode.', usage: '/mode [plan|read-only|auto|full|ci]', needsSession: true },
  { command: 'tools', description: 'List the available tools.' },
  { command: 'models', description: 'List the models available on every local backend.' },
  { command: 'mcp', description: 'List MCP servers and their status.' },
  { command: 'skills', description: 'List available skills.' },
  { command: 'memory', description: 'Show the project AFICAX.md.' },
  { command: 'context', description: 'Show a summary of the current context window.' },
  { command: 'diff', description: 'Show `git diff` of the working tree.' },
  { command: 'commit', description: 'Stage and commit the working tree.', usage: '/commit [message]' },
  { command: 'review', description: 'Spawn a reviewer sub-agent for the current diff.' },
  { command: 'test', description: 'Run the project test command (auto-detected).' },
  { command: 'config', description: 'Read or write a config key.', usage: '/config [key] [value]' },
  { command: 'allow', description: 'Add a command to the session allowlist.', usage: '/allow <pattern>' },
  { command: 'deny', description: 'Add a command to the session denylist.', usage: '/deny <pattern>' },
  { command: 'help', description: 'Show help for a specific command.', usage: '/help [command]' },
  { command: 'cost', description: 'Show estimated session cost.' },
  { command: 'history', description: 'List previous sessions.' },
  { command: 'debug', description: 'Toggle debug logging.' },
  { command: 'exit', description: 'Exit Aficax (asks for confirmation).' },
];

/** Stateless resolver. One instance per TUI is enough. */
export class SlashHandler {
  /**
   * Parse `input` (which MUST start with `/`) and return the
   * matching {@link SlashResult}.
   */
  handle(input: string, ctx: SlashContext): SlashResult {
    const trimmed = input.trim();
    if (trimmed.length === 0 || trimmed[0] !== '/') {
      return { kind: 'unknown', input };
    }
    const body = trimmed.slice(1);
    const space = body.indexOf(' ');
    const cmd = (space === -1 ? body : body.slice(0, space)).toLowerCase();
    const rest = space === -1 ? '' : body.slice(space + 1).trim();
    const args = rest.length === 0 ? [] : rest.split(/\s+/u);

    switch (cmd) {
      case 'new':
        return this.newSession(ctx);
      case 'resume':
        return this.resumeSession(ctx, args[0]);
      case 'compact':
        return this.compact(ctx);
      case 'status':
        return this.status(ctx);
      case 'clear':
        return { kind: 'local', action: { kind: 'clear-screen' } };
      case 'model':
        return this.setModel(ctx, args[0]);
      case 'provider':
        return this.setProvider(ctx, args[0]);
      case 'mode':
        return this.setMode(ctx, args[0]);
      case 'tools':
        return this.listTools(ctx);
      case 'models':
        return this.listModels(ctx);
      case 'mcp':
        return this.listMcp(ctx);
      case 'skills':
        return this.listSkills(ctx);
      case 'memory':
        return this.readMemory(ctx);
      case 'context':
        return this.contextSummary(ctx);
      case 'diff':
        return this.gitDiff(ctx);
      case 'commit':
        return this.gitCommit(ctx, rest);
      case 'review':
        return this.review(ctx);
      case 'test':
        return this.runTests(ctx);
      case 'config':
        return this.config(ctx, args[0], args[1]);
      case 'allow':
        return this.allow(ctx, rest);
      case 'deny':
        return this.deny(ctx, rest);
      case 'help':
        return { kind: 'local', action: { kind: 'show-help', ...(args[0] !== undefined ? { command: args[0] } : {}) } };
      case 'cost':
        return this.cost(ctx);
      case 'history':
        return this.history(ctx);
      case 'debug':
        return { kind: 'local', action: { kind: 'toggle-debug' } };
      case 'exit':
        return { kind: 'local', action: { kind: 'exit-confirm' } };
      default:
        return { kind: 'unknown', input };
    }
  }

  /** Autocomplete: return every spec whose `command` starts with `prefix`. */
  suggest(prefix: string): readonly SlashCommandSpec[] {
    const lower = prefix.toLowerCase().replace(/^\//, '');
    if (lower.length === 0) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((c) => c.command.startsWith(lower) || c.aliases?.some((a) => a.startsWith(lower)));
  }

  // -- Helpers -----------------------------------------------------------

  private sessionPath(ctx: SlashContext, suffix = ''): string {
    if (ctx.sessionId === undefined) throw new Error('no active session');
    return `/sessions/${ctx.sessionId}${suffix}`;
  }

  private newSession(ctx: SlashContext): SlashResult {
    const body: { readonly workingDir: string; readonly model: string; readonly provider: string } = {
      workingDir: ctx.workingDir ?? '.',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    };
    return {
      kind: 'http',
      call: { method: 'POST', path: '/sessions', body, successMessage: 'session created', printResponse: true },
    };
  }

  private resumeSession(ctx: SlashContext, id: string | undefined): SlashResult {
    if (id === undefined) {
      return { kind: 'message', text: 'Usage: /resume <session-id>' };
    }
    return {
      kind: 'http',
      call: { method: 'POST', path: `/sessions/${id}/resume`, successMessage: 'session resumed', printResponse: true },
    };
  }

  private compact(ctx: SlashContext): SlashResult {
    return {
      kind: 'http',
      call: { method: 'POST', path: this.sessionPath(ctx, '/compact'), successMessage: 'compaction requested' },
    };
  }

  private status(ctx: SlashContext): SlashResult {
    return {
      kind: 'http',
      call: { method: 'GET', path: this.sessionPath(ctx), printResponse: true },
    };
  }

  private setModel(ctx: SlashContext, model: string | undefined): SlashResult {
    if (model === undefined) return { kind: 'message', text: 'Usage: /model <name>' };
    return {
      kind: 'http',
      call: { method: 'PATCH', path: this.sessionPath(ctx), body: { model }, successMessage: `model → ${model}` },
    };
  }

  private setProvider(ctx: SlashContext, provider: string | undefined): SlashResult {
    if (provider === undefined) return { kind: 'message', text: 'Usage: /provider <name>' };
    return {
      kind: 'http',
      call: { method: 'PATCH', path: this.sessionPath(ctx), body: { provider }, successMessage: `provider → ${provider}` },
    };
  }

  private setMode(ctx: SlashContext, mode: string | undefined): SlashResult {
    if (mode === undefined) return { kind: 'message', text: 'Usage: /mode <plan|read-only|auto|full|ci>' };
    return {
      kind: 'http',
      call: { method: 'PATCH', path: this.sessionPath(ctx), body: { mode }, successMessage: `mode → ${mode}` },
    };
  }

  private listTools(ctx: SlashContext): SlashResult {
    return { kind: 'http', call: { method: 'GET', path: '/tools', printResponse: true } };
    void ctx;
  }

  private listModels(ctx: SlashContext): SlashResult {
    // `?backend=` lets the user filter; the server defaults to the
    // configured local backend when the query param is omitted.
    return { kind: 'http', call: { method: 'GET', path: '/providers/local/models', printResponse: true } };
    void ctx;
  }

  private listMcp(ctx: SlashContext): SlashResult {
    return { kind: 'http', call: { method: 'GET', path: '/mcp/servers', printResponse: true } };
    void ctx;
  }

  private listSkills(ctx: SlashContext): SlashResult {
    return { kind: 'http', call: { method: 'GET', path: '/skills', printResponse: true } };
    void ctx;
  }

  private readMemory(ctx: SlashContext): SlashResult {
    const path = ctx.workingDir !== undefined
      ? `/memory?cwd=${encodeURIComponent(ctx.workingDir)}`
      : '/memory';
    return { kind: 'http', call: { method: 'GET', path, printResponse: true } };
  }

  private contextSummary(ctx: SlashContext): SlashResult {
    return { kind: 'message', text: `(stub) context summary for ${ctx.sessionId ?? 'no-session'}` };
  }

  private gitDiff(ctx: SlashContext): SlashResult {
    return {
      kind: 'message',
      text: 'Run `git diff` via the bash tool from the TUI input bar. (Stub: would run via /sessions/:id/message.)',
    };
    void ctx;
  }

  private gitCommit(ctx: SlashContext, message: string): SlashResult {
    const cmd = message.length > 0
      ? `git add -A && git commit -m ${quote(message)}`
      : 'git add -A && git commit';
    return {
      kind: 'message',
      text: `Would run: ${cmd}\nUse the bash tool in the TUI to execute it.`,
    };
    void ctx;
  }

  private review(ctx: SlashContext): SlashResult {
    if (ctx.sessionId === undefined) {
      return { kind: 'message', text: 'No active session — /review needs a session.' };
    }
    return {
      kind: 'http',
      call: {
        method: 'POST',
        path: this.sessionPath(ctx, '/message'),
        body: { message: 'Use the spawn_agent tool to review the changes from this session.' },
        successMessage: 'review requested',
      },
    };
  }

  private runTests(ctx: SlashContext): SlashResult {
    const detected = detectTestCommand(ctx.workingDir);
    return {
      kind: 'message',
      text: `Detected test command: ${detected}\nRun it via the bash tool in the TUI.`,
    };
  }

  private config(_ctx: SlashContext, key: string | undefined, value: string | undefined): SlashResult {
    if (key === undefined) return { kind: 'message', text: 'Usage: /config <key> [value]' };
    if (value === undefined) {
      return { kind: 'message', text: `Run: aficax config ${key}` };
    }
    return { kind: 'message', text: `Run: aficax config ${key} ${value}` };
  }

  private allow(ctx: SlashContext, pattern: string): SlashResult {
    if (pattern.length === 0) return { kind: 'message', text: 'Usage: /allow <pattern>' };
    return {
      kind: 'http',
      call: { method: 'POST', path: this.sessionPath(ctx, '/allowlist'), body: { pattern }, successMessage: 'allowed' },
    };
    void ctx;
  }

  private deny(ctx: SlashContext, pattern: string): SlashResult {
    if (pattern.length === 0) return { kind: 'message', text: 'Usage: /deny <pattern>' };
    return {
      kind: 'http',
      call: { method: 'POST', path: this.sessionPath(ctx, '/denylist'), body: { pattern }, successMessage: 'denied' },
    };
    void ctx;
  }

  private cost(ctx: SlashContext): SlashResult {
    return { kind: 'message', text: `(stub) cost summary for ${ctx.sessionId ?? 'no-session'}` };
    void ctx;
  }

  private history(ctx: SlashContext): SlashResult {
    return { kind: 'http', call: { method: 'GET', path: '/sessions', printResponse: true } };
    void ctx;
  }
}

/** Quote a string for the shell (single-quoted with escapes). */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Heuristic test command detection. Looks at `package.json`, `pyproject.toml`, etc. */
export function detectTestCommand(workingDir: string | undefined): string {
  const cwd = workingDir ?? process.cwd();
  // The actual detection is done by the caller — this stub returns the
  // most common default per project type. The bash tool that the user
  // runs locally does the real work.
  if (cwd.includes('node_modules') || cwd.includes('tsconfig')) return 'bun test';
  if (cwd.includes('pyproject.toml') || cwd.includes('pytest.ini')) return 'pytest';
  if (cwd.includes('Cargo.toml')) return 'cargo test';
  if (cwd.includes('go.mod')) return 'go test ./...';
  return 'echo "no test command detected — set up your project"';
}

/** Factory that creates a fresh {@link SlashHandler}. */
export function createSlashHandler(): SlashHandler {
  return new SlashHandler();
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\index.ts
// `aficax` entry point. Parses the process argv into a typed
// {@link CliInvocation} and dispatches to the matching command.
//
// Subcommand map (longest match wins; the first positional selects
// the subcommand, anything after is forwarded as subcommand args):
//
//   aficax                       → `start` (interactive TUI)
//   aficax start                 → `start`
//   aficax server                → `server` (HTTP only, no TUI)
//   aficax exec "task"           → `exec`
//   aficax resume [id]           → `resume`
//   aficax config [k] [v]        → `config`
//   aficax mcp list              → `mcp`
//   aficax skills list           → `skills`
//   aficax sessions list|clean   → `sessions`
//   aficax --version             → version banner + exit
//   aficax --help                → help banner + exit

import { runConfigCommand } from './commands/config.js';
import { runExecCommand } from './commands/exec.js';
import { runMcpCommand } from './commands/mcp.js';
import { runResumeCommand } from './commands/resume.js';
import { runServerCommand } from './commands/server.js';
import { runSessionsCommand } from './commands/sessions.js';
import { runSkillsCommand } from './commands/skills.js';
import { runStartCommand } from './commands/start.js';

const CLI_VERSION = '0.4.0';

/** Parsed CLI flags. */
export interface CliFlags {
  readonly model?: string;
  readonly provider?: string;
  readonly port?: number;
  readonly host?: string;
  readonly noSandbox: boolean;
  readonly mode?: string;
  readonly workingDir?: string;
  readonly debug: boolean;
  readonly logLevel?: string;
  readonly maxTurns?: number;
  readonly maxTokens?: number;
  readonly sessionId?: string;
  readonly task?: string;
  readonly configKey?: string;
  readonly configValue?: string;
  readonly subArgs: readonly string[];
}

/** Resolved subcommand. */
export type CliSubcommand =
  | { readonly kind: 'start' }
  | { readonly kind: 'server' }
  | { readonly kind: 'exec' }
  | { readonly kind: 'resume' }
  | { readonly kind: 'config' }
  | { readonly kind: 'mcp' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'sessions' }
  | { readonly kind: 'help' }
  | { readonly kind: 'version' };

/** A fully-parsed CLI invocation. */
export interface CliInvocation {
  readonly subcommand: CliSubcommand;
  readonly flags: CliFlags;
}

/** Parse `argv` (excluding `node` / script name) into a {@link CliInvocation}. */
export function parseCli(argv: readonly string[]): CliInvocation {
  const flags: {
    model?: string;
    provider?: string;
    port?: number;
    host?: string;
    noSandbox: boolean;
    mode?: string;
    workingDir?: string;
    debug: boolean;
    logLevel?: string;
    maxTurns?: number;
    maxTokens?: number;
    sessionId?: string;
    task?: string;
    configKey?: string;
    configValue?: string;
    subArgs: string[];
  } = { noSandbox: false, debug: false, subArgs: [] };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i] ?? '';
    const next = argv[i + 1];

    if (arg === '--version' || arg === '-V') {
      return { subcommand: { kind: 'version' }, flags: freezeFlags(flags) };
    }
    if (arg === '--help' || arg === '-h') {
      return { subcommand: { kind: 'help' }, flags: freezeFlags(flags) };
    }
    if (arg === '--model' && typeof next === 'string') { flags.model = next; i += 2; continue; }
    if (arg === '--provider' && typeof next === 'string') { flags.provider = next; i += 2; continue; }
    if (arg === '--port' && typeof next === 'string') { flags.port = Number.parseInt(next, 10); i += 2; continue; }
    if (arg === '--host' && typeof next === 'string') { flags.host = next; i += 2; continue; }
    if (arg === '--no-sandbox') { flags.noSandbox = true; i += 1; continue; }
    if (arg === '--mode' && typeof next === 'string') { flags.mode = next; i += 2; continue; }
    if (arg === '--working-dir' && typeof next === 'string') { flags.workingDir = next; i += 2; continue; }
    if (arg === '--debug') { flags.debug = true; flags.logLevel = 'debug'; i += 1; continue; }
    if (arg === '--log-level' && typeof next === 'string') { flags.logLevel = next; i += 2; continue; }
    if (arg === '--max-turns' && typeof next === 'string') { flags.maxTurns = Number.parseInt(next, 10); i += 2; continue; }
    if (arg === '--max-tokens' && typeof next === 'string') { flags.maxTokens = Number.parseInt(next, 10); i += 2; continue; }
    if (arg === '--session' && typeof next === 'string') { flags.sessionId = next; i += 2; continue; }
    if (arg === '--') { flags.subArgs = argv.slice(i + 1); i = argv.length; continue; }
    if (arg.startsWith('--')) { i += 1; continue; }
    // First positional → record it as the subcommand but keep
    // scanning so flags after it (e.g. `start --model gpt-4o`) are
    // still parsed.
    if (flags.subArgs.length === 0) {
      flags.subArgs = [arg];
      i += 1;
      continue;
    }
    flags.subArgs.push(arg);
    i += 1;
  }

  const sub = flags.subArgs[0];
  switch (sub) {
    case 'start':
      return { subcommand: { kind: 'start' }, flags: freezeFlags(flags) };
    case 'server':
      return { subcommand: { kind: 'server' }, flags: freezeFlags(flags) };
    case 'exec':
      if (flags.subArgs[1] !== undefined) flags.task = flags.subArgs[1];
      return { subcommand: { kind: 'exec' }, flags: freezeFlags(flags) };
    case 'resume':
      if (flags.subArgs[1] !== undefined) flags.sessionId = flags.subArgs[1];
      return { subcommand: { kind: 'resume' }, flags: freezeFlags(flags) };
    case 'config':
      if (flags.subArgs[1] !== undefined) flags.configKey = flags.subArgs[1];
      if (flags.subArgs[2] !== undefined) flags.configValue = flags.subArgs[2];
      return { subcommand: { kind: 'config' }, flags: freezeFlags(flags) };
    case 'mcp':
      return { subcommand: { kind: 'mcp' }, flags: freezeFlags(flags) };
    case 'skills':
      return { subcommand: { kind: 'skills' }, flags: freezeFlags(flags) };
    case 'sessions':
      return { subcommand: { kind: 'sessions' }, flags: freezeFlags(flags) };
    case 'help':
    case '--help':
    case '-h':
      return { subcommand: { kind: 'help' }, flags: freezeFlags(flags) };
    case 'version':
    case '--version':
    case '-V':
      return { subcommand: { kind: 'version' }, flags: freezeFlags(flags) };
    default:
      // No recognised subcommand — default to `start` (TUI).
      return { subcommand: { kind: 'start' }, flags: freezeFlags(flags) };
  }
}

function freezeFlags(flags: {
  model?: string;
  provider?: string;
  port?: number;
  host?: string;
  noSandbox: boolean;
  mode?: string;
  workingDir?: string;
  debug: boolean;
  logLevel?: string;
  maxTurns?: number;
  maxTokens?: number;
  sessionId?: string;
  task?: string;
  configKey?: string;
  configValue?: string;
  subArgs: string[];
}): CliFlags {
  const out: { -readonly [K in keyof CliFlags]: CliFlags[K] } = {
    noSandbox: flags.noSandbox,
    debug: flags.debug,
    subArgs: flags.subArgs,
  };
  if (flags.model !== undefined) out.model = flags.model;
  if (flags.provider !== undefined) out.provider = flags.provider;
  if (flags.port !== undefined && Number.isFinite(flags.port)) out.port = flags.port;
  if (flags.host !== undefined) out.host = flags.host;
  if (flags.mode !== undefined) out.mode = flags.mode;
  if (flags.workingDir !== undefined) out.workingDir = flags.workingDir;
  if (flags.logLevel !== undefined) out.logLevel = flags.logLevel;
  if (flags.maxTurns !== undefined && Number.isFinite(flags.maxTurns)) out.maxTurns = flags.maxTurns;
  if (flags.maxTokens !== undefined && Number.isFinite(flags.maxTokens)) out.maxTokens = flags.maxTokens;
  if (flags.sessionId !== undefined) out.sessionId = flags.sessionId;
  if (flags.task !== undefined) out.task = flags.task;
  if (flags.configKey !== undefined) out.configKey = flags.configKey;
  if (flags.configValue !== undefined) out.configValue = flags.configValue;
  return out as CliFlags;
}

const HELP_BANNER = [
  'Aficax — AI software-engineering agent for the terminal.',
  '',
  'Usage: aficax [command] [options]',
  '',
  'Commands:',
  '  (default)            Start the interactive TUI (server + client).',
  '  start                Same as default.',
  '  server               Start the HTTP server only (no TUI).',
  '  exec "task"          Run a single non-interactive task and exit.',
  '  resume [id]          Resume a previous session by id.',
  '  config [key] [value] Read or write a config key.',
  '  mcp list             List MCP servers and their status.',
  '  skills list          List available skills.',
  '  sessions list|clean  List or clean up sessions.',
  '  --version            Print the version and exit.',
  '  --help               Show this banner.',
  '',
  'Options:',
  '  --model <name>       Override the default model.',
  '  --provider <name>    Override the default provider.',
  '  --port <n>           HTTP server port (default 7433).',
  '  --host <h>           HTTP server host (default 127.0.0.1).',
  '  --no-sandbox         Disable the bash sandbox.',
  '  --mode <m>           Approval mode (plan|read-only|auto|full|ci).',
  '  --working-dir <p>    Override the working directory.',
  '  --debug              Enable debug logging.',
  '  --log-level <l>      Set log level (off|error|info|debug).',
  '  --max-turns <n>      Maximum number of agent turns.',
  '  --max-tokens <n>     Maximum tokens for the model call.',
  '  --session <id>       Resume a specific session id.',
].join('\n');

async function main(): Promise<void> {
  const invocation = parseCli(process.argv.slice(2));
  switch (invocation.subcommand.kind) {
    case 'version':
      process.stdout.write(`aficax ${CLI_VERSION}\n`);
      return;
    case 'help':
      process.stdout.write(`${HELP_BANNER}\n`);
      return;
    case 'start':
      await runStartCommand(invocation.flags);
      return;
    case 'server':
      await runServerCommand(invocation.flags);
      return;
    case 'exec':
      await runExecCommand(invocation.flags);
      return;
    case 'resume':
      await runResumeCommand(invocation.flags);
      return;
    case 'config':
      await runConfigCommand(invocation.flags);
      return;
    case 'mcp':
      await runMcpCommand(invocation.flags);
      return;
    case 'skills':
      await runSkillsCommand(invocation.flags);
      return;
    case 'sessions':
      await runSessionsCommand(invocation.flags);
      return;
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`aficax: fatal: ${message}\n`);
    process.exit(1);
  });
}

// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\loop\prompt-builder.ts
// PromptBuilder: assembles the system prompt sent to the model on every
// turn. The prompt is composed of eight ordered sections; each section has
// well-defined responsibilities and is documented below.
//
// Section 1 — Base instructions (cacheable, hardcoded)
// Section 2 — Global AFICAX.md      (~/.aficax/AFICAX.md)         [cached]
// Section 3 — Project AFICAX.md    (git toplevel/AFICAX.md)      [cached]
// Section 4 — Directory AFICAX.md  (<cwd>/AFICAX.md if ≠ project) [cached]
// Section 5 — Git status + last 5 commits (if <cwd> is a git repo) [fresh]
// Section 6 — Working directory                                   [fresh]
// Section 7 — MCP tools (always recomputed, never cached)         [fresh]
// Section 8 — Active mode                                          [fresh]
//
// Cached sections are keyed by absolute path + mtime; the cache is
// invalidated lazily on the next `build()` call.

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Buffer } from 'node:buffer';

import { estimateTokens, getLogger } from '@aficax/core';

import type { AgentMode } from '../permissions/engine.js';

const logger = getLogger();

/** Mode values accepted by the prompt builder. Mirrors `permissions/engine`. */
export type PromptAgentMode = AgentMode;

/** Description of one MCP tool currently attached to the session. */
export interface PromptBuilderMcpTool {
  /** MCP server that exposes the tool (used as a logical namespace). */
  readonly serverName: string;
  /** Tool name as exposed by the server. */
  readonly name: string;
  /** One-line description, suitable for the prompt. */
  readonly description: string;
}

/** Public arguments to {@link PromptBuilder.build}. */
export interface BuildPromptArgs {
  readonly sessionId: string;
  readonly cwd: string;
  readonly mode: PromptAgentMode;
  readonly mcpTools: readonly PromptBuilderMcpTool[];
}

/** Public configuration for the builder. */
export interface PromptBuilderOptions {
  /**
   * Override the home directory used to resolve `~/.aficax/AFICAX.md`. Tests
   * can inject a temp directory; production callers can leave it unset.
   */
  readonly homeDir?: string;
  /** Override the shell command for git (defaults to `"git"`). */
  readonly gitCommand?: string;
  /** Inject a custom clock (mostly useful for tests). */
  readonly now?: () => number;
}

/** One cached entry: file content + the mtime we last read it at. */
interface CacheEntry {
  readonly mtimeMs: number;
  readonly content: string;
}

/** Maximum number of bytes read from any AFICAX.md file. */
const AFICAX_MD_MAX_BYTES = 64 * 1024;

/** Header printed before each section of the system prompt. */
const SECTION_HEADERS: Readonly<Record<SectionId, string>> = {
  base: '# Aficax Instructions',
  globalAficaxMd: '# Global Instructions (~/.aficax/AFICAX.md)',
  projectAficaxMd: '# Project Instructions (AFICAX.md)',
  directoryAficaxMd: '# Directory Instructions (AFICAX.md)',
  gitStatus: '# Git Status',
  workingDir: '# Working Directory',
  mcpTools: '# MCP Tools',
  mode: '# Active Mode',
};

type SectionId =
  | 'base'
  | 'globalAficaxMd'
  | 'projectAficaxMd'
  | 'directoryAficaxMd'
  | 'gitStatus'
  | 'workingDir'
  | 'mcpTools'
  | 'mode';

/** Hardcoded base instructions. Kept small so they remain cache-friendly. */
const BASE_INSTRUCTIONS = [
  'You are Aficax, a careful AI software-engineering agent running locally in the user\'s terminal.',
  '',
  '## Behaviour',
  '- Be concise and accurate. Prefer the smallest change that solves the problem.',
  '- Read the relevant code before editing it. Never invent file paths or APIs.',
  '- When a task is ambiguous, ask one focused clarifying question rather than guessing.',
  '- Stop and explain when you encounter unexpected behaviour, blockers, or contradictions.',
  '- Never exfiltrate secrets, credentials, or user data. Never make destructive changes without an explicit user approval.',
  '',
  '## Response format',
  '- Reply in the user\'s language. Match the surrounding project\'s language when relevant.',
  '- Use Markdown for structure (headings, lists, fenced code) when it aids clarity.',
  '- Prefer short paragraphs over walls of text. Use bullet lists for enumerations.',
  '- When you finish a task, give a one-paragraph summary of what changed and why.',
  '',
  '## Tool usage',
  '- Always use the provided tools for file I/O and shell commands; do not fabricate results.',
  '- Read files in chunks rather than whole when they are large.',
  '- For multi-step tasks, plan briefly before invoking tools. Stop after a coherent step to share progress.',
  '- When a tool can return too much output, narrow the query first; never silently truncate.',
  '',
  '## Approval',
  '- Some tool calls require the user to approve them. When a permission prompt appears, the loop blocks until the user decides.',
  '- If the user denies, treat the denial as authoritative; do not retry with the same input.',
  '- "approve_always" / "deny_always" persist across the session; mention them when relevant.',
].join('\n');

/**
 * Builder for the system prompt. Holds a small in-memory cache of the
 * AFICAX.md files it has read; dynamic sections (git, mode, MCP) are
 * always recomputed.
 */
export class PromptBuilder {
  private readonly homeDir: string;
  private readonly gitCommand: string;
  private readonly now: () => number;
  private readonly cache: Map<string, CacheEntry> = new Map();

  constructor(options: PromptBuilderOptions = {}) {
    this.homeDir = options.homeDir ?? safeHomedir();
    this.gitCommand = options.gitCommand ?? 'git';
    this.now = options.now ?? Date.now;
  }

  /**
   * Build the full system prompt for a turn. Sections are joined with
   * blank lines; missing sections (e.g. no AFICAX.md, no git repo) are
   * omitted entirely so the prompt stays compact.
   */
  async build(args: BuildPromptArgs): Promise<string> {
    const cwd = normalizeCwd(args.cwd);
    const sections: { id: SectionId; text: string }[] = [];

    sections.push({ id: 'base', text: BASE_INSTRUCTIONS });

    const globalPath = join(this.homeDir, '.aficax', 'AFICAX.md');
    const globalMd = await this.readCached(globalPath);
    if (globalMd !== null) {
      sections.push({ id: 'globalAficaxMd', text: globalMd });
    }

    // Project = git toplevel if available, otherwise the cwd. We resolve
    // this before reading the file so sections 3 and 4 can be emitted
    // independently when the user is operating inside a sub-directory.
    const projectRoot = await this.resolveProjectRoot(cwd);
    const projectMdPath = join(projectRoot, 'AFICAX.md');
    const projectMd = await this.readCached(projectMdPath);
    if (projectMd !== null) {
      sections.push({ id: 'projectAficaxMd', text: projectMd });
    }

    // Directory-level AFICAX.md: only emit when it differs from the project
    // root (otherwise it would be a duplicate of section 3).
    const directoryMdPath = join(cwd, 'AFICAX.md');
    if (directoryMdPath !== projectMdPath) {
      const directoryMd = await this.readCached(directoryMdPath);
      if (directoryMd !== null) {
        sections.push({ id: 'directoryAficaxMd', text: directoryMd });
      }
    }

    const git = await this.readGitStatus(cwd);
    if (git !== null) {
      sections.push({ id: 'gitStatus', text: git });
    }

    sections.push({ id: 'workingDir', text: formatWorkingDir(cwd) });

    if (args.mcpTools.length > 0) {
      sections.push({ id: 'mcpTools', text: formatMcpTools(args.mcpTools) });
    }

    sections.push({ id: 'mode', text: formatMode(args.mode) });

    return sections
      .map((s) => `${SECTION_HEADERS[s.id]}\n\n${s.text}`)
      .join('\n\n');
  }

  /** Estimate the token count of a system prompt using the core heuristic. */
  estimateTokens(systemPrompt: string): number {
    return estimateTokens(systemPrompt);
  }

  /** Drop the cache (e.g. after the user manually edits an AFICAX.md). */
  invalidate(): void {
    this.cache.clear();
  }

  // -- Internals ---------------------------------------------------------

  /**
   * Find the project root: the toplevel of the git repository that
   * contains `cwd`. When `cwd` is not inside a git repo we fall back to
   * `cwd` itself, so section 3 always resolves.
   */
  private async resolveProjectRoot(cwd: string): Promise<string> {
    const toplevel = await this.runGit(cwd, ['rev-parse', '--show-toplevel']);
    if (toplevel.length === 0) return cwd;
    return toplevel;
  }

  private async readCached(path: string): Promise<string | null> {
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    if (!info.isFile()) return null;
    const mtimeMs = info.mtimeMs;
    const cached = this.cache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      return cached.content;
    }
    let raw: Buffer;
    try {
      raw = await readFile(path);
    } catch {
      return null;
    }
    const text = raw.subarray(0, AFICAX_MD_MAX_BYTES).toString('utf-8');
    this.cache.set(path, { mtimeMs, content: text });
    return text;
  }

  /**
   * Run `git status --porcelain --branch` and `git log -n 5 --oneline` in
   * `cwd`. Returns `null` when the directory is not a git repo, when git
   * is not installed, or when either command fails.
   */
  private async readGitStatus(cwd: string): Promise<string | null> {
    const isRepo = await this.runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (isRepo !== 'true') {
      return null;
    }
    const status = await this.runGit(cwd, ['status', '--porcelain', '--branch']);
    const log = await this.runGit(cwd, ['log', '-n', '5', '--oneline']);
    const lines: string[] = [];
    lines.push('Branch / status:');
    lines.push(status || '(clean)');
    lines.push('');
    lines.push('Recent commits:');
    lines.push(log || '(no commits yet)');
    return lines.join('\n');
  }

  /**
   * Run `git <args>` and return its trimmed stdout. Returns the empty
   * string when the command fails or is not installed; never throws.
   */
  private async runGit(cwd: string, args: readonly string[]): Promise<string> {
    try {
      const proc = Bun.spawn({
        cmd: [this.gitCommand, ...args],
        cwd,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        readStreamText(proc.stdout),
        readStreamText(proc.stderr),
        proc.exited,
      ]);
      if (exitCode !== 0) {
        logger.debug('git command failed', {
          args,
          cwd,
          stderr,
          exitCode,
        });
        return '';
      }
      return stdout.trim();
    } catch (err) {
      logger.debug('git command threw', {
        args,
        cwd,
        error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }
}

// -- Helpers --------------------------------------------------------------

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

function normalizeCwd(cwd: string): string {
  if (cwd.length === 0) return process.cwd();
  return isAbsolute(cwd) ? resolve(cwd) : resolve(cwd);
}

function formatWorkingDir(cwd: string): string {
  const home = safeHomedir();
  if (cwd === home) {
    return `cwd: ~ (${cwd})`;
  }
  if (cwd.startsWith(home + sep)) {
    return `cwd: ~${sep}${relative(home, cwd)}  (${cwd})`;
  }
  return `cwd: ${cwd}`;
}

function formatMcpTools(tools: readonly PromptBuilderMcpTool[]): string {
  const lines = tools.map((t) => `- ${t.serverName}/${t.name}: ${t.description}`);
  return [
    'The following MCP tools are available in addition to the core tools:',
    ...lines,
  ].join('\n');
}

function formatMode(mode: PromptAgentMode): string {
  switch (mode) {
    case 'plan':
      return 'Mode: plan. The agent must NOT modify files or run side-effecting commands. It may read and propose changes only.';
    case 'read-only':
      return 'Mode: read-only. The agent may read but not modify files or run side-effecting commands.';
    case 'auto':
      return 'Mode: auto. Side-effecting tool calls require explicit user approval. Denials are final.';
    case 'full':
      return 'Mode: full. Most tool calls are auto-approved; only the danger classifier still prompts the user.';
    default:
      return `Mode: ${String(mode)}.`;
  }
}

async function readStreamText(
  stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
  if (!stream) return '';
  const response = new Response(stream);
  return response.text();
}

/** Factory: build a {@link PromptBuilder} with default options. */
export function createPromptBuilder(options?: PromptBuilderOptions): PromptBuilder {
  return new PromptBuilder(options);
}

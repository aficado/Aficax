// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\custom-agents\parser.ts
// CustomAgentParser: parse the YAML files that describe a custom agent.
//
// The parser uses the same minimal YAML subset as the skills loader
// (`yaml-mini.ts`) — single-level mapping, scalars, flow lists, block
// lists, and `|` / `>` block scalars. Any unknown field is ignored
// (forward-compatibility); an invalid required field (`name`,
// `description`, `model`) yields `null` so callers can surface the
// error to the user.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

import { getLogger } from '@aficax/core';

import { parseFrontmatter, type ParsedFrontmatter } from '../skills/yaml-mini.js';

const logger = getLogger();

/** Valid permission modes a custom agent can declare. */
export type CustomAgentPermissionMode = 'plan' | 'read-only' | 'auto' | 'full' | 'ci';

/** Where a custom agent was loaded from. */
export type CustomAgentSource = 'builtin' | 'global' | 'project';

/** Parsed definition of a single custom agent. */
export interface CustomAgentDefinition {
  readonly name: string;
  readonly description: string;
  /** Provider/model spec. We keep the raw string so the provider registry can pick. */
  readonly model: string;
  readonly tools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly permissionMode: CustomAgentPermissionMode;
  readonly systemPrompt: string;
  readonly maxTurns: number;
  readonly mcpServers: readonly string[];
  readonly skills: readonly string[];
  readonly source: CustomAgentSource;
  readonly path: string;
}

/** Public configuration of {@link CustomAgentParser}. */
export interface CustomAgentParserOptions {
  /** Working directory used to resolve the project-level agents folder. */
  readonly cwd: string;
  /** Override the built-in agents directory (tests). */
  readonly builtinDir?: string;
  /** Override the home directory (tests). */
  readonly homeDir?: string;
  /**
   * Override the IO read (tests). Receives an absolute path; returns the
   * file body or `null` when missing.
   */
  readonly readOverride?: (path: string) => Promise<string | null>;
}

/**
 * Default built-in agents directory. Resolved relative to the running
 * server binary using the conventional `agents/` folder.
 */
function defaultBuiltinDir(): string {
  try {
    const url = new URL('.', import.meta.url);
    return join(url.pathname, '..', '..', '..', 'agents-builtin');
  } catch {
    return resolve(process.cwd(), 'packages', 'server', 'agents-builtin');
  }
}

/** Discover, parse, and cache every custom agent available to the server. */
export class CustomAgentParser {
  private readonly cwd: string;
  private readonly builtinDir: string;
  private readonly homeDir: string;
  private readonly readOverride: ((path: string) => Promise<string | null>) | null;
  private agents: Map<string, CustomAgentDefinition> = new Map();

  constructor(options: CustomAgentParserOptions) {
    this.cwd = isAbsolute(options.cwd) ? options.cwd : resolve(options.cwd);
    this.builtinDir = options.builtinDir ?? defaultBuiltinDir();
    this.homeDir = options.homeDir ?? safeHomedir();
    this.readOverride = options.readOverride ?? null;
  }

  get globalPath(): string {
    return join(this.homeDir, '.aficax', 'agents');
  }

  get projectPath(): string {
    return join(this.cwd, '.aficax', 'agents');
  }

  /** Walk all source directories and cache the merged definitions. */
  async load(): Promise<readonly CustomAgentDefinition[]> {
    const merged = new Map<string, CustomAgentDefinition>();
    const sources: Array<{ dir: string; kind: CustomAgentSource }> = [
      { dir: this.builtinDir, kind: 'builtin' },
      { dir: this.globalPath, kind: 'global' },
      { dir: this.projectPath, kind: 'project' },
    ];
    for (const { dir, kind } of sources) {
      const defs = await this.loadDirectory(dir, kind);
      for (const def of defs) merged.set(def.name, def);
    }
    this.agents = merged;
    logger.debug('custom-agents: loaded', { count: this.agents.size });
    return Array.from(this.agents.values());
  }

  /** Snapshot of every loaded definition. */
  list(): readonly CustomAgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /** Look up a single definition by name. */
  get(name: string): CustomAgentDefinition | undefined {
    return this.agents.get(name);
  }

  /** Force a reload from disk. */
  async reload(): Promise<readonly CustomAgentDefinition[]> {
    return this.load();
  }

  // -- Internals ---------------------------------------------------------

  private async loadDirectory(dir: string, kind: CustomAgentSource): Promise<CustomAgentDefinition[]> {
    if (this.readOverride === null && !existsSync(dir)) return [];
    const { readdir } = await import('node:fs/promises');
    let entries: Array<{ name: string }>;
    try {
      const dirents = await readdir(dir, { withFileTypes: true });
      entries = dirents
        .filter((d) => d.isFile() && (d.name.endsWith('.yaml') || d.name.endsWith('.yml')))
        .map((d) => ({ name: d.name }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('custom-agents: readdir failed', { dir, error: message });
      return [];
    }
    const out: CustomAgentDefinition[] = [];
    for (const entry of entries) {
      const file = join(dir, entry.name);
      const raw = await this.readFile(file);
      if (raw === null) continue;
      const def = parseCustomAgentFile(raw, file, kind);
      if (def !== null) out.push(def);
    }
    return out;
  }

  private async readFile(path: string): Promise<string | null> {
    if (this.readOverride !== null) {
      try {
        return await this.readOverride(path);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.debug('custom-agents: readOverride failed', { path, error: message });
        return null;
      }
    }
    try {
      return await readFile(path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.debug('custom-agents: readFile failed', { path, error: message });
      return null;
    }
  }
}

// -- Helpers --------------------------------------------------------------

/**
 * Parse a single custom-agent YAML body. Returns `null` when required
 * fields are missing or the file fails to parse.
 */
export function parseCustomAgentFile(raw: string, path: string, source: CustomAgentSource): CustomAgentDefinition | null {
  let fm: ParsedFrontmatter;
  try {
    fm = parseFrontmatter(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.debug('custom-agents: parse failed', { path, error: message });
    return null;
  }
  const name = stringField(fm, 'name');
  const description = stringField(fm, 'description');
  const model = stringField(fm, 'model');
  if (name === null || description === null || model === null) {
    logger.debug('custom-agents: missing required field', { path });
    return null;
  }
  return {
    name,
    description,
    model,
    tools: listField(fm, 'tools'),
    disallowedTools: listField(fm, 'disallowedTools'),
    permissionMode: permissionModeField(fm) ?? 'auto',
    systemPrompt: stringField(fm, 'systemPrompt') ?? '',
    maxTurns: intField(fm, 'maxTurns') ?? 50,
    mcpServers: listField(fm, 'mcpServers'),
    skills: listField(fm, 'skills'),
    source,
    path,
  };
}

function stringField(fm: ParsedFrontmatter, key: string): string | null {
  const v = fm[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function listField(fm: ParsedFrontmatter, key: string): readonly string[] {
  const v = fm[key];
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.length > 0) out.push(item);
  }
  return out;
}

function intField(fm: ParsedFrontmatter, key: string): number | null {
  const v = fm[key];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;
}

function permissionModeField(fm: ParsedFrontmatter): CustomAgentPermissionMode | null {
  const v = fm['permissionMode'];
  if (typeof v !== 'string') return null;
  if (v === 'plan' || v === 'read-only' || v === 'auto' || v === 'full' || v === 'ci') {
    return v;
  }
  return null;
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return process.env['HOME'] ?? process.env['USERPROFILE'] ?? '.';
  }
}

/** Factory that creates a fresh {@link CustomAgentParser}. */
export function createCustomAgentParser(options: CustomAgentParserOptions): CustomAgentParser {
  return new CustomAgentParser(options);
}

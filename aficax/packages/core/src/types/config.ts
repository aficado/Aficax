// C:\Users\aficado\Desktop\Aficax\aficax\packages\core\src\types\config.ts
// Multi-layer configuration types (global, project, directory) for Aficax.

import type { ProviderType } from './provider.js';

/** User-selectable approval mode controlling how the loop handles actions. */
export type ApprovalMode = 'plan' | 'read-only' | 'auto' | 'full' | 'ci';

/** Where a configuration value comes from in the precedence chain. */
export type ConfigScope = 'global' | 'project' | 'directory';

/** Filesystem and process isolation level for bash and other side-effecting tools. */
export interface SandboxConfig {
  readonly enabled: boolean;
  readonly level: 'none' | 'os' | 'container' | 'microvm';
  /** Whether the sandbox permits outbound network connections. */
  readonly allowNetwork: boolean;
  /** Allowlist of domains for outbound network connections. */
  readonly allowedDomains: readonly string[];
}

/** Telemetry, logging, and metrics configuration. */
export interface TelemetryConfig {
  readonly enabled: boolean;
  readonly level: 'off' | 'error' | 'info' | 'debug';
  /** Opt-in flag: send anonymous usage metrics to a configured endpoint. */
  readonly reportUsage: boolean;
}

/** Lifecycle event a hook can be attached to. */
export type HookEvent =
  | 'PreAPICall'
  | 'PostAPICall'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PreUserPromptSubmit'
  | 'OnSessionStart'
  | 'OnSessionEnd'
  | 'OnError';

/** A single hook definition. */
export interface HookDefinition {
  readonly event: HookEvent;
  /** Shell command or executable path to run when the hook fires. */
  readonly command: string;
  /** Maximum execution time in milliseconds. */
  readonly timeout?: number;
}

/** Hooks configuration block. */
export interface HooksConfig {
  readonly enabled: boolean;
  /** When true, a hook failure aborts the action it was guarding. */
  readonly failClosed: boolean;
  readonly definitions: readonly HookDefinition[];
}

/** Skills subsystem configuration. */
export interface SkillsConfig {
  readonly enabled: boolean;
  /** When true, the agent auto-activates skills based on the user's task. */
  readonly autoActivate: boolean;
  /** Additional directories searched for skills, in order of precedence. */
  readonly paths: readonly string[];
}

/** Auto-memory and project memory knobs. */
export interface MemoryConfig {
  readonly autoMemory: boolean;
  /** Hard cap on the number of auto-memory lines loaded per session. */
  readonly maxAutoMemoryLines: number;
  /** Hard cap on memory size in bytes loaded per session. */
  readonly maxMemoryBytes: number;
}

/** Top-level Aficax configuration, after merging all scopes. */
export interface AficaxConfig {
  readonly provider: ProviderType;
  readonly model: string;
  readonly approvalMode: ApprovalMode;
  readonly maxTurns: number;
  readonly maxTokens: number;
  readonly sandbox: SandboxConfig;
  readonly telemetry: TelemetryConfig;
  readonly hooks: HooksConfig;
  readonly skills: SkillsConfig;
  readonly memory: MemoryConfig;
  /** Optional smaller model used for titles, summarisation, and classification. */
  readonly smallModel?: string;
  readonly mcpServers: readonly string[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  /** Command allowlist, applied in addition to tool-level permissions. */
  readonly allowlist: readonly string[];
  /** Command denylist, blocks matching commands regardless of mode. */
  readonly denylist: readonly string[];
}

/** A resolved config value plus its origin for debugging and display. */
export interface ResolvedConfig {
  readonly config: AficaxConfig;
  readonly scope: ConfigScope;
  readonly source: string;
}

/** Compile a default AficaxConfig usable as a baseline before merges. */
export function defaultAficaxConfig(): AficaxConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    approvalMode: 'auto',
    maxTurns: 50,
    maxTokens: 200_000,
    sandbox: {
      enabled: false,
      level: 'none',
      allowNetwork: true,
      allowedDomains: [],
    },
    telemetry: {
      enabled: true,
      level: 'info',
      reportUsage: false,
    },
    hooks: {
      enabled: true,
      failClosed: false,
      definitions: [],
    },
    skills: {
      enabled: true,
      autoActivate: true,
      paths: [],
    },
    memory: {
      autoMemory: true,
      maxAutoMemoryLines: 200,
      maxMemoryBytes: 25 * 1024,
    },
    mcpServers: [],
    allowedTools: [],
    disallowedTools: [],
    allowlist: [],
    denylist: [],
  };
}

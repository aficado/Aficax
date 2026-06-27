// C:\Users\aficado\Desktop\Aficax\aficax\packages\cli\src\commands\config.ts
// `aficax config [key] [value]` — read or write a single config key.
//
// Keys use dot notation (`providers.anthropic.apiKey`,
// `agent.maxTurns`, `sandbox.enabled`). When `value` is omitted the
// command prints the current resolved value; when supplied, the value
// is written to the project config (`<cwd>/.aficax/settings.json`).

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { getLogger } from '@aficax/core';
import { createConfigLoader, type ConfigFile, type MergeValue, mergeConfigs } from '@aficax/server';

import type { CliFlags } from '../index.js';

const logger = getLogger();

export async function runConfigCommand(flags: CliFlags): Promise<void> {
  const cwd = flags.workingDir ? (isAbsolute(flags.workingDir) ? flags.workingDir : resolve(flags.workingDir)) : process.cwd();
  const loader = createConfigLoader({ cwd });
  const { config, validation } = await loader.load();
  if (validation.errors.length > 0) {
    for (const err of validation.errors) process.stderr.write(`error: ${err}\n`);
    process.exit(1);
  }
  const key = flags.configKey;
  if (key === undefined || key.length === 0) {
    process.stdout.write(JSON.stringify(config, null, 2) + '\n');
    return;
  }
  const currentValue = readPath(config as unknown as MergeValue, key.split('.'));
  if (flags.configValue === undefined) {
    process.stdout.write(`${key} = ${JSON.stringify(currentValue)}\n`);
    return;
  }
  await writeConfigValue(cwd, key, flags.configValue);
  process.stdout.write(`${key} = ${JSON.stringify(flags.configValue)}\n`);
  logger.info('config: wrote key', { key, value: flags.configValue });
}

function readPath(value: MergeValue, path: readonly string[]): MergeValue {
  let cursor: MergeValue = value;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as { [key: string]: MergeValue })[segment] ?? null;
  }
  return cursor;
}

async function writeConfigValue(cwd: string, key: string, raw: string): Promise<void> {
  const path = join(cwd, '.aficax', 'settings.json');
  await mkdir(resolve(path, '..'), { recursive: true });
  let existing: ConfigFile = {};
  if (existsSync(path)) {
    try {
      const text = await readFile(path, 'utf-8');
      existing = JSON.parse(text) as ConfigFile;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('config: could not parse existing settings.json', { path, error: message });
    }
  }
  const segments = key.split('.');
  const value = parseValue(raw);
  const next = setPath(existing as unknown as MergeValue, segments, value) as ConfigFile;
  await writeFile(path, JSON.stringify(next, null, 2) + '\n', 'utf-8');
}

function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^-?\d+$/u.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/u.test(raw)) return Number.parseFloat(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try { return JSON.parse(raw) as unknown; } catch { /* fallthrough */ }
  }
  return raw;
}

function setPath(root: MergeValue, path: readonly string[], value: unknown): MergeValue {
  if (path.length === 0) return value as MergeValue;
  const [head, ...rest] = path;
  if (head === undefined) return root;
  const base = (root !== null && typeof root === 'object' && !Array.isArray(root))
    ? { ...(root as { [key: string]: MergeValue }) }
    : {};
  base[head] = setPath(base[head], rest, value);
  return mergeConfigs(root ?? {}, base);
}

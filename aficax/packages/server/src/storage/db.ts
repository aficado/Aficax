// C:\Users\aficado\Desktop\Aficax\aficax\packages\server\src\storage\db.ts
// SQLite + Drizzle ORM wiring. Uses bun:sqlite under the hood (Bun's
// built-in driver); the database file lives at ~/.aficax/aficax.db.

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { drizzle, type BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { getLogger } from '@aficax/core';

import * as schema from './schema.js';

const logger = getLogger();

/** Default location of the Aficax SQLite database file. */
export const DEFAULT_DB_PATH = join(homedir(), '.aficax', 'aficax.db');

/** Inferred Drizzle database type, scoped to the schema. */
export type AficaxDatabase = BunSQLiteDatabase<typeof schema>;

/** SQL statements run at startup to bring a fresh database up to schema. */
const BOOTSTRAP_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    working_dir TEXT NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL,
    title TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    token_count INTEGER,
    tool_call_id TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    timestamp INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp
     ON messages(session_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session_timestamp
     ON tool_calls(session_id, timestamp)`,
];

/** Resolved database configuration. */
export interface DbConfig {
  readonly path: string;
  readonly readonly: boolean;
}

/** Result of {@link openDatabase}: the Drizzle client plus the raw handle. */
export interface DbHandle {
  readonly db: AficaxDatabase;
  readonly sqlite: BunDatabase;
  readonly path: string;
  close(): void;
}

/** Open (or create) the Aficax database and run the bootstrap SQL. */
export function openDatabase(config: Partial<DbConfig> = {}): DbHandle {
  const path = config.path ?? DEFAULT_DB_PATH;
  const readonly = config.readonly ?? false;

  const dir = join(path, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const sqlite = readonly
    ? new BunDatabase(path, { readonly: true })
    : new BunDatabase(path);
  if (!readonly) {
    sqlite.exec('PRAGMA journal_mode = WAL');
    sqlite.exec('PRAGMA synchronous = NORMAL');
    sqlite.exec('PRAGMA foreign_keys = ON');
  }

  for (const stmt of BOOTSTRAP_SQL) {
    sqlite.exec(stmt);
  }

  const db = drizzle(sqlite, { schema });
  logger.info('Database opened', { path });

  return {
    db,
    sqlite,
    path,
    close(): void {
      sqlite.close();
    },
  };
}

/** Convenience: open a default in-memory database (used by tests). */
export function openInMemoryDatabase(): DbHandle {
  const sqlite = new BunDatabase(':memory:');
  for (const stmt of BOOTSTRAP_SQL) {
    sqlite.exec(stmt);
  }
  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    path: ':memory:',
    close(): void {
      sqlite.close();
    },
  };
}

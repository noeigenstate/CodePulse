/**
 * Database connection helpers. Opens a `better-sqlite3` database wrapped by
 * Drizzle and ensures the schema exists via idempotent bootstrap DDL.
 *
 * @module storage/sqlite/db
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

/** The Drizzle database handle, typed with the full {@link schema}. */
export type DB = BetterSQLite3Database<typeof schema>

/** The result of {@link openDb}: the Drizzle handle and the raw driver. */
export interface OpenDbResult {
  /** The Drizzle query interface used by the repository. */
  db: DB
  /** The underlying `better-sqlite3` connection (for pragmas/maintenance). */
  sqlite: Database.Database
}

/**
 * Opens (creating if needed) the SQLite database at `file` and ensures the
 * schema exists.
 *
 * Tables are bootstrapped with idempotent `CREATE TABLE IF NOT EXISTS` DDL so
 * the app runs without a separate `drizzle-kit migrate` step for the MVP; the
 * Drizzle {@link schema} remains the source of truth for generated migrations.
 * Enables WAL journaling and foreign keys.
 *
 * @param file Absolute path to the SQLite file (parent dirs are created).
 * @returns The Drizzle handle and the raw driver.
 * @throws If the native `better-sqlite3` addon cannot be loaded (ABI mismatch);
 *   callers in the Electron main process catch this and run without persistence.
 */
export function openDb(file: string): OpenDbResult {
  mkdirSync(dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  ensureSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * Creates every table and index if it does not already exist.
 *
 * @param sqlite The raw `better-sqlite3` connection to run DDL against.
 */
function ensureSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      installed INTEGER NOT NULL DEFAULT 0,
      configured INTEGER NOT NULL DEFAULT 0,
      version TEXT,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      git_branch TEXT,
      last_active_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      external_session_id TEXT NOT NULL,
      workspace_id TEXT,
      model TEXT,
      state TEXT NOT NULL DEFAULT 'idle',
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS sessions_external_idx
      ON sessions (agent_type, external_session_id);

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      external_turn_id TEXT,
      state TEXT NOT NULL,
      prompt_preview TEXT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      need_permission INTEGER NOT NULL DEFAULT 0,
      need_user_input INTEGER NOT NULL DEFAULT 0,
      last_assistant_message TEXT
    );
    CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id);

    CREATE TABLE IF NOT EXISTS token_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      agent_type TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      context_used_percent REAL,
      cost_usd REAL,
      accuracy TEXT NOT NULL DEFAULT 'unknown',
      captured_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS token_session_idx ON token_snapshots (session_id);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      external_session_id TEXT,
      external_turn_id TEXT,
      workspace_path TEXT,
      model TEXT,
      tool_name TEXT,
      command TEXT,
      message TEXT,
      raw TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS events_session_idx ON events (external_session_id);
    CREATE INDEX IF NOT EXISTS events_ts_idx ON events (timestamp);
  `)
}

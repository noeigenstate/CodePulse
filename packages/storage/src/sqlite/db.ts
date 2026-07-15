/**
 * 数据库连接辅助函数。打开由 Drizzle 包装的 `better-sqlite3` 数据库，
 * 并通过幂等的引导 DDL 确保 schema 存在。
 *
 * @module storage/sqlite/db
 */
import { createRequire } from 'node:module'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { toPersistedFileTypeHints } from '../privacy.js'
import * as schema from './schema.js'

/** Privacy scrub + file_type_hints column. Bump when scrub semantics change. */
const PRIVACY_SCHEMA_VERSION = 2
const PRIVATE_CLEAR_BATCH = 2_000
const HINT_MIGRATE_BATCH = 500

/** 携带完整 {@link schema} 类型信息的 Drizzle 数据库句柄。 */
export type DB = BetterSQLite3Database<typeof schema>

/** {@link openDb} 的结果：Drizzle 句柄与原始驱动。 */
export interface OpenDbResult {
  /** 仓储使用的 Drizzle 查询接口。 */
  db: DB
  /** 底层 `better-sqlite3` 连接（用于 pragma/维护）。 */
  sqlite: Database.Database
}

/**
 * Resolve the native addon path explicitly.
 *
 * better-sqlite3 defaults to `require('bindings')(...)`. Installers that strip
 * the `bindings` package then fail to open SQLite even though the .node file
 * is present. Passing `nativeBinding` avoids that dependency.
 */
function openSqlite(file: string): Database.Database {
  try {
    const req = createRequire(import.meta.url)
    const nativeBinding = req.resolve('better-sqlite3/build/Release/better_sqlite3.node')
    return new Database(file, { nativeBinding })
  } catch {
    // Dev / unpackaged fallback: let better-sqlite3 load via bindings.
    return new Database(file)
  }
}

/**
 * 打开（必要时创建）位于 `file` 的 SQLite 数据库并确保 schema 存在。
 *
 * 表通过幂等的 `CREATE TABLE IF NOT EXISTS` DDL 引导创建，使 MVP
 * 无需单独的 `drizzle-kit migrate` 步骤；Drizzle {@link schema}
 * 仍是生成迁移的唯一可信来源。同时启用 WAL 日志与外键。
 *
 * @param file SQLite 文件的绝对路径（父目录会被创建）。
 * @returns Drizzle 句柄与原始驱动。
 * @throws 当原生 `better-sqlite3` 扩展无法加载（ABI 不匹配）时抛出；
 *   Electron 主进程的调用方会捕获并在无持久化模式下运行。
 */
export function openDb(file: string): OpenDbResult {
  mkdirSync(dirname(file), { recursive: true })
  const sqlite = openSqlite(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('secure_delete = ON')
  ensureStorageSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
}

/**
 * 幂等补齐表结构与隐私列。可在 openDb 后再次调用（例如统计查询自愈）。
 *
 * @param sqlite 原始 better-sqlite3 连接。
 */
export function ensureStorageSchema(sqlite: Database.Database): void {
  ensureSchema(sqlite)
  ensureEventPrivacyColumns(sqlite)
  migratePrivateEventData(sqlite)
  installPrivacyGuards(sqlite)
}

/**
 * 通过 Drizzle 句柄自愈缺失列与隐私残留（兼容旧库）。
 */
export function healStorageSchema(db: DB): void {
  const client = getSqliteClient(db)
  if (!client) return
  try {
    ensureStorageSchema(client)
  } catch (err) {
    console.error('[codepulse] storage schema heal failed', err)
  }
}

function getSqliteClient(db: DB): Database.Database | undefined {
  const client = (
    db as unknown as { $client?: Database.Database; session?: { client?: Database.Database } }
  ).$client
  if (client && typeof client.prepare === 'function') return client
  const sessionClient = (db as unknown as { session?: { client?: Database.Database } }).session
    ?.client
  if (sessionClient && typeof sessionClient.prepare === 'function') return sessionClient
  return undefined
}

/**
 * 创建所有不存在的表与索引。
 *
 * @param sqlite 执行 DDL 的原始 `better-sqlite3` 连接。
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
      file_type_hints TEXT,
      raw TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS events_session_idx ON events (external_session_id);
    CREATE INDEX IF NOT EXISTS events_ts_idx ON events (timestamp);
  `)
}

/** Add privacy-safe derived columns to databases created by older versions. */
function ensureEventPrivacyColumns(sqlite: Database.Database): void {
  const columns = sqlite.prepare('PRAGMA table_info(events)').all() as Array<{ name: string }>
  if (!columns.some((column) => column.name === 'file_type_hints')) {
    console.log('[codepulse] migrating events: add column file_type_hints')
    sqlite.exec('ALTER TABLE events ADD COLUMN file_type_hints TEXT')
  }
}

/**
 * Remove private payloads written by older versions before exposing the database.
 *
 * Never aborts openDb solely because WAL is busy: scrubbing raw/command is more
 * important than an exclusive checkpoint. Batches large tables so 40k+ rows still finish.
 */
function migratePrivateEventData(sqlite: Database.Database): void {
  const userVersion = Number(sqlite.pragma('user_version', { simple: true }))
  const privateCount = countPrivateRows(sqlite)

  if (userVersion >= PRIVACY_SCHEMA_VERSION && privateCount === 0) return

  if (privateCount > 0) {
    console.log(
      `[codepulse] privacy scrub: clearing raw/command on ${privateCount} event row(s) (user_version=${userVersion})`,
    )
  }

  checkpointWal(sqlite, { required: false })

  // Derive allowlisted extensions from legacy commands before wiping them.
  migrateCommandHintsBatched(sqlite)

  const cleared = clearPrivateColumnsBatched(sqlite)
  if (cleared > 0) {
    console.log(`[codepulse] privacy scrub: nullified raw/command on ${cleared} row(s)`)
  }

  checkpointWal(sqlite, { required: false })

  const remaining = countPrivateRows(sqlite)
  if (remaining > 0) {
    // Do not bump user_version — next open will retry.
    console.error(
      `[codepulse] privacy scrub incomplete: ${remaining} row(s) still hold raw/command; will retry on next start`,
    )
    return
  }

  sqlite.pragma(`user_version = ${Math.max(userVersion, PRIVACY_SCHEMA_VERSION)}`)
  if (cleared > 0) compactAfterPrivacyMigration(sqlite)
}

function countPrivateRows(sqlite: Database.Database): number {
  const row = sqlite
    .prepare('SELECT count(*) AS count FROM events WHERE raw IS NOT NULL OR command IS NOT NULL')
    .get() as { count: number }
  return Number(row?.count ?? 0)
}

function migrateCommandHintsBatched(sqlite: Database.Database): void {
  const select = sqlite.prepare(
    `SELECT id, command FROM events
     WHERE command IS NOT NULL
       AND (file_type_hints IS NULL OR file_type_hints = '')
     LIMIT ?`,
  )
  const saveHints = sqlite.prepare(
    "UPDATE events SET file_type_hints = ? WHERE id = ? AND (file_type_hints IS NULL OR file_type_hints = '')",
  )

  for (;;) {
    const batch = select.all(HINT_MIGRATE_BATCH) as Array<{ id: string; command: string }>
    if (batch.length === 0) break
    const tx = sqlite.transaction((rows: Array<{ id: string; command: string }>) => {
      for (const row of rows) {
        saveHints.run(toPersistedFileTypeHints(row.command) ?? null, row.id)
      }
    })
    tx(batch)
  }
}

function clearPrivateColumnsBatched(sqlite: Database.Database): number {
  // Prefer rowid batch deletes of sensitive columns for large legacy DBs.
  const clearBatch = sqlite.prepare(
    `UPDATE events
     SET raw = NULL, command = NULL
     WHERE rowid IN (
       SELECT rowid FROM events
       WHERE raw IS NOT NULL OR command IS NOT NULL
       LIMIT ?
     )`,
  )

  let total = 0
  for (;;) {
    const result = clearBatch.run(PRIVATE_CLEAR_BATCH)
    total += result.changes
    if (result.changes === 0) break
  }
  return total
}

/** Reject future code paths that attempt to reintroduce raw hooks or commands. */
function installPrivacyGuards(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TRIGGER IF NOT EXISTS events_private_payload_insert_guard
    BEFORE INSERT ON events
    WHEN NEW.raw IS NOT NULL OR NEW.command IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'private event payload persistence is disabled');
    END;

    CREATE TRIGGER IF NOT EXISTS events_private_payload_update_guard
    BEFORE UPDATE OF raw, command ON events
    WHEN NEW.raw IS NOT NULL OR NEW.command IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'private event payload persistence is disabled');
    END;
  `)
}

function checkpointWal(sqlite: Database.Database, options: { required?: boolean } = {}): void {
  try {
    const [result] = sqlite.pragma('wal_checkpoint(TRUNCATE)') as Array<{
      busy: number
      log: number
      checkpointed: number
    }>
    if (result && result.busy !== 0) {
      const message = 'SQLite privacy migration could not obtain an exclusive WAL checkpoint'
      if (options.required) throw new Error(message)
      console.warn(`[codepulse] ${message} (continuing scrub)`)
    }
  } catch (err) {
    if (options.required) throw err
    console.warn('[codepulse] WAL checkpoint skipped', err)
  }
}

/**
 * secure_delete + checkpoint already removes readable content. VACUUM is a
 * best-effort size recovery step because it may require another database-sized
 * block of temporary disk space.
 */
function compactAfterPrivacyMigration(sqlite: Database.Database): void {
  try {
    sqlite.exec('VACUUM')
    checkpointWal(sqlite, { required: false })
  } catch (error) {
    console.warn('[codepulse] private event data cleared; SQLite compaction deferred', error)
  }
}

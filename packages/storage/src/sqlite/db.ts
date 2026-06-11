/**
 * 数据库连接辅助函数。打开由 Drizzle 包装的 `better-sqlite3` 数据库，
 * 并通过幂等的引导 DDL 确保 schema 存在。
 *
 * @module storage/sqlite/db
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

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
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  ensureSchema(sqlite)
  const db = drizzle(sqlite, { schema })
  return { db, sqlite }
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
      raw TEXT,
      timestamp INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE INDEX IF NOT EXISTS events_session_idx ON events (external_session_id);
    CREATE INDEX IF NOT EXISTS events_ts_idx ON events (timestamp);
  `)
}

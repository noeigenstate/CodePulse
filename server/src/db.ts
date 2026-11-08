import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginManifest, PluginReviewState } from '@codepulse/shared'

export interface Developer {
  id: string
  email: string
  name: string
  password_hash: string | null
  admin: number
}

export interface Version {
  id: string
  plugin_id: string
  version: string
  manifest_json: string
  payload_json: string
  state: PluginReviewState
  note: string
  submitted_at: number
  reviewed_at: number | null
  webhook_secret: string
}

export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')
  const revision = db.pragma('user_version', { simple: true }) as number
  if (revision > 2) {
    db.close()
    throw new Error('数据库版本过新')
  }
  if (revision === 0) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE developers (
          id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
          password_hash TEXT, created_at INTEGER NOT NULL
        );
        CREATE TABLE clients (
          id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('developer','store','store-code')),
          subject TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX sessions_expiry ON sessions(expires_at);
        CREATE TABLE plugins (
          id TEXT PRIMARY KEY, developer_id TEXT NOT NULL REFERENCES developers(id),
          name TEXT NOT NULL, summary TEXT NOT NULL, webhook_secret TEXT NOT NULL,
          created_at INTEGER NOT NULL, live_version_id TEXT REFERENCES versions(id)
        );
        CREATE TABLE versions (
          id TEXT PRIMARY KEY, plugin_id TEXT NOT NULL REFERENCES plugins(id), version TEXT NOT NULL,
          manifest_json TEXT NOT NULL, payload_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('draft','pending','approved','rejected')),
          note TEXT NOT NULL DEFAULT '', submitted_at INTEGER NOT NULL, reviewed_at INTEGER,
          UNIQUE(plugin_id, version)
        );
        CREATE TABLE installs (
          client_id TEXT NOT NULL REFERENCES clients(id), plugin_id TEXT NOT NULL REFERENCES plugins(id),
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), settings_json TEXT NOT NULL,
          installed_at INTEGER NOT NULL, PRIMARY KEY(client_id, plugin_id)
        );
        CREATE TABLE card_cache (
          plugin_id TEXT NOT NULL REFERENCES plugins(id), version_id TEXT NOT NULL REFERENCES versions(id),
          settings_hash TEXT NOT NULL, cards_json TEXT NOT NULL, error TEXT NOT NULL,
          generated_at INTEGER, expires_at INTEGER NOT NULL,
          PRIMARY KEY(plugin_id, version_id, settings_hash)
        );
        PRAGMA user_version = 1;
      `)
    })()
  }
  if (revision < 2) {
    db.transaction(() => {
      db.exec(`ALTER TABLE developers ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK(admin IN (0,1));
        PRAGMA user_version = 2;`)
    })()
  }
  return db
}

export function liveVersion(db: Database.Database, pluginId: string): Version | undefined {
  return db
    .prepare(
      `SELECT v.*, p.webhook_secret FROM plugins p
    JOIN versions v ON v.id = p.live_version_id
    WHERE p.id = ? AND v.state = 'approved'`,
    )
    .get(pluginId) as Version | undefined
}

export function manifestOf(version: Version): PluginManifest {
  return JSON.parse(version.manifest_json) as PluginManifest
}

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'
import Database from 'better-sqlite3'
import type { DeskMemory, DeskTask, DeskTaskInput } from '@codepulse/shared'

/** Port of LumaDesk's WAL reminder store; never opens or migrates the source database. */
export class AssistantStore {
  private db: Database.Database
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let nativeBinding: string | undefined
    try {
      nativeBinding = createRequire(import.meta.url).resolve(
        'better-sqlite3/build/Release/better_sqlite3.node',
      )
    } catch {
      /* CJS test bundle falls back to the packaged bindings loader. */
    }
    this.db = nativeBinding ? new Database(path, { nativeBinding }) : new Database(path)
    if (path !== ':memory:')
      try {
        chmodSync(path, 0o600)
      } catch {
        /* Windows uses user directory ACLs. */
      }
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 5000')
    this.db.pragma('secure_delete = ON')
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > 1) {
      this.db.close()
      throw new Error('待办数据来自更新版本，请升级客户端')
    }
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS desk_tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, notes TEXT NOT NULL,
        dueAt INTEGER, status TEXT NOT NULL, reminderState TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, notifiedAt INTEGER);
        CREATE INDEX IF NOT EXISTS desk_due ON desk_tasks(status, reminderState, dueAt);
        CREATE TABLE IF NOT EXISTS desk_memories(id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS desk_announcements(id TEXT PRIMARY KEY, taskId TEXT NOT NULL, text TEXT NOT NULL, expiresAt INTEGER NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS desk_announcement_task ON desk_announcements(taskId);
        CREATE TABLE IF NOT EXISTS desk_announcement_acks(id TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY(id,device));
        CREATE TABLE IF NOT EXISTS desk_preferences(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
        PRAGMA user_version = 1;`)
    })()
  }
  list(): DeskTask[] {
    return this.db
      .prepare(
        `SELECT * FROM desk_tasks ORDER BY
      CASE status WHEN 'pending' THEN 0 ELSE 1 END, dueAt IS NULL, dueAt, createdAt DESC LIMIT 1000`,
      )
      .all() as DeskTask[]
  }
  settings(): unknown {
    const row = this.db.prepare('SELECT value FROM desk_preferences WHERE id=1').get() as
      | { value: string }
      | undefined
    return row ? JSON.parse(row.value) : undefined
  }
  saveSettings(value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO desk_preferences VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(JSON.stringify(value))
  }
  get(id: string): DeskTask | undefined {
    return this.db.prepare('SELECT * FROM desk_tasks WHERE id=?').get(id) as DeskTask | undefined
  }
  add(input: DeskTaskInput, now = Date.now()): DeskTask {
    const pending = this.db
      .prepare("SELECT COUNT(*) AS count FROM desk_tasks WHERE status='pending'")
      .get() as { count: number }
    if (pending.count >= 1000) throw new Error('待办较多，请先完成或取消部分事项后再添加')
    const title = text(input.title, 160, true),
      notes = text(input.notes ?? '', 2000)
    const dueAt = due(input.dueAt, now)
    const task: DeskTask = {
      id: randomUUID(),
      title,
      notes,
      dueAt,
      status: 'pending',
      reminderState: dueAt === null ? 'none' : 'pending',
      createdAt: now,
      updatedAt: now,
      notifiedAt: null,
    }
    this.db
      .prepare(
        'INSERT INTO desk_tasks VALUES (@id,@title,@notes,@dueAt,@status,@reminderState,@createdAt,@updatedAt,@notifiedAt)',
      )
      .run(task)
    return task
  }
  update(id: string, input: DeskTaskInput, now = Date.now()): DeskTask {
    const previous = this.require(id)
    if (previous.status !== 'pending') throw new Error('已结束的事项不能直接编辑')
    const title = text(input.title, 160, true),
      notes = text(input.notes ?? '', 2000),
      unchangedTime = (input.dueAt ?? null) === previous.dueAt,
      dueAt = unchangedTime ? previous.dueAt : due(input.dueAt, now)
    this.db
      .prepare(
        `UPDATE desk_tasks SET title=?,notes=?,dueAt=?,reminderState=?,notifiedAt=?,updatedAt=? WHERE id=? AND status='pending'`,
      )
      .run(
        title,
        notes,
        dueAt,
        unchangedTime ? previous.reminderState : dueAt === null ? 'none' : 'pending',
        unchangedTime ? previous.notifiedAt : null,
        Math.max(now, previous.updatedAt + 1),
        id,
      )
    return this.require(id)
  }
  finish(id: string, status: 'completed' | 'cancelled', now = Date.now()): DeskTask {
    const previous = this.require(id)
    this.db
      .prepare('UPDATE desk_tasks SET status=?,updatedAt=? WHERE id=?')
      .run(status, Math.max(now, previous.updatedAt + 1), id)
    return this.require(id)
  }
  snooze(id: string, seconds: number, now = Date.now()): DeskTask {
    const previous = this.require(id)
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 31_536_000)
      throw new Error('延后时间无效')
    this.db
      .prepare(
        `UPDATE desk_tasks SET dueAt=?,status='pending',reminderState='pending',notifiedAt=NULL,updatedAt=? WHERE id=?`,
      )
      .run(now + seconds * 1000, Math.max(now, previous.updatedAt + 1), id)
    return this.require(id)
  }
  due(now: number): DeskTask[] {
    return this.db
      .prepare(
        "SELECT * FROM desk_tasks WHERE status='pending' AND reminderState='pending' AND dueAt<=? ORDER BY dueAt LIMIT 100",
      )
      .all(now) as DeskTask[]
  }
  recordReminder(id: string, state: 'delivered' | 'expired', now: number): void {
    this.db
      .prepare(
        "UPDATE desk_tasks SET reminderState=?,notifiedAt=? WHERE id=? AND status='pending' AND reminderState='pending'",
      )
      .run(state, state === 'delivered' ? now : null, id)
  }
  memories(): DeskMemory[] {
    return this.db
      .prepare('SELECT * FROM desk_memories ORDER BY createdAt DESC LIMIT 100')
      .all() as DeskMemory[]
  }
  remember(value: string, now = Date.now()): void {
    this.db
      .prepare('INSERT INTO desk_memories VALUES (?,?,?)')
      .run(randomUUID(), text(value, 500, true), now)
  }
  forget(id: string): void {
    this.db.prepare('DELETE FROM desk_memories WHERE id=?').run(id)
  }
  announcements(
    now: number,
  ): { id: string; taskId: string; text: string; expiresAt: number; acked: string[] }[] {
    const rows = this.db
      .prepare(
        "SELECT a.* FROM desk_announcements a JOIN desk_tasks t ON t.id=a.taskId WHERE a.expiresAt>? AND t.status='pending' AND a.text=t.title AND a.expiresAt=t.dueAt+1800000 ORDER BY a.expiresAt LIMIT 1000",
      )
      .all(now) as { id: string; taskId: string; text: string; expiresAt: number }[]
    return rows.map((row) => ({
      ...row,
      acked: (
        this.db.prepare('SELECT device FROM desk_announcement_acks WHERE id=?').all(row.id) as {
          device: string
        }[]
      ).map((a) => a.device),
    }))
  }
  announce(
    id: string,
    taskId: string,
    value: string,
    expiresAt: number,
  ): { id: string; taskId: string; text: string; expiresAt: number } {
    this.db
      .prepare('INSERT OR IGNORE INTO desk_announcements VALUES(?,?,?,?)')
      .run(id, taskId, value, expiresAt)
    return this.db.prepare('SELECT * FROM desk_announcements WHERE taskId=?').get(taskId) as {
      id: string
      taskId: string
      text: string
      expiresAt: number
    }
  }
  ackAnnouncement(id: string, device: string): void {
    this.db.prepare('INSERT OR IGNORE INTO desk_announcement_acks VALUES(?,?)').run(id, device)
  }
  removeTaskAnnouncements(taskId: string): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM desk_announcement_acks WHERE id IN(SELECT id FROM desk_announcements WHERE taskId=?)',
        )
        .run(taskId)
      this.db.prepare('DELETE FROM desk_announcements WHERE taskId=?').run(taskId)
    })()
  }
  pruneAnnouncements(now: number): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM desk_announcements WHERE expiresAt<=?').run(now)
      this.db
        .prepare(
          'DELETE FROM desk_announcement_acks WHERE id NOT IN(SELECT id FROM desk_announcements)',
        )
        .run()
    })()
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)()
  }
  close(): void {
    this.db.close()
  }
  private require(id: string): DeskTask {
    if (typeof id !== 'string' || id.length > 80) throw new Error('待办不存在')
    const task = this.get(id)
    if (!task) throw new Error('待办不存在')
    return task
  }
}
export function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max) throw new Error('内容长度或格式无效')
  const out = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim()
  if (required && !out) throw new Error('请填写内容')
  return out
}
function due(value: unknown, now: number): number | null {
  if (value === undefined || value === null) return null
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value <= now ||
    value > now + 10 * 366 * 86400000
  )
    throw new Error('提醒时间应在未来十年内')
  return value
}

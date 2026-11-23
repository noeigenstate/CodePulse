import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { tokenHash } from './auth.js'
import { HttpError, invalid } from './validation.js'

/** No I, O, 0 or 1, so a code read aloud or copied by hand cannot be mistaken. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const INVITE_DEFAULT_DAYS = 14
export const INVITE_MAX_DAYS = 90
export const INVITE_NOTE_MAX = 40

export type InviteState = 'unused' | 'used' | 'expired' | 'revoked'

export interface InviteView {
  id: string
  note: string
  state: InviteState
  createdAt: number
  expiresAt: number
  createdBy: string | null
  usedBy: { email: string; name: string } | null
  usedAt: number | null
}

interface InviteRow {
  id: string
  note: string
  created_at: number
  expires_at: number
  used_at: number | null
  revoked_at: number | null
  creator: string | null
  used_email: string | null
  used_name: string | null
}

/** `CP-XXXX-XXXX-XXXX`: 60 random bits, far beyond what the registration rate limit lets anyone guess. */
function newCode(): string {
  const body = Array.from(randomBytes(12), (byte) => ALPHABET[byte & 31]).join('')
  return `CP-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`
}

/** Case, spaces and dashes do not matter when someone types a code in. */
export const inviteHash = (code: string): string =>
  tokenHash(code.toUpperCase().replace(/[^A-Z0-9]/g, ''))

export function inviteDays(value: unknown): number {
  if (value === undefined) return INVITE_DEFAULT_DAYS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > INVITE_MAX_DAYS)
    invalid(`有效期须为 1–${INVITE_MAX_DAYS} 天`)
  return value
}

export function createInvite(
  db: Database.Database,
  options: { now: number; days?: number; note?: string; createdBy?: string | null },
): { code: string; invite: InviteView } {
  const id = randomUUID()
  const code = newCode()
  const days = options.days ?? INVITE_DEFAULT_DAYS
  db.prepare(
    `INSERT INTO invites (id, code_hash, note, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    inviteHash(code),
    options.note ?? '',
    options.createdBy ?? null,
    options.now,
    options.now + days * 86400000,
  )
  return { code, invite: listInvites(db, options.now).find((invite) => invite.id === id)! }
}

export function listInvites(db: Database.Database, now: number): InviteView[] {
  const rows = db
    .prepare(
      `SELECT i.*, c.name AS creator, u.email AS used_email, u.name AS used_name
      FROM invites i LEFT JOIN developers c ON c.id = i.created_by
      LEFT JOIN developers u ON u.id = i.used_by ORDER BY i.created_at DESC, i.rowid DESC`,
    )
    .all() as InviteRow[]
  return rows.map((row) => ({
    id: row.id,
    note: row.note,
    state: row.used_email
      ? 'used'
      : row.revoked_at !== null
        ? 'revoked'
        : row.expires_at <= now
          ? 'expired'
          : 'unused',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    createdBy: row.creator,
    usedBy: row.used_email ? { email: row.used_email, name: row.used_name ?? '' } : null,
    usedAt: row.used_at,
  }))
}

/** True while the code can still register an account. */
export function inviteUsable(db: Database.Database, code: string, now: number): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT id FROM invites WHERE code_hash = ? AND used_by IS NULL
        AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(inviteHash(code), now),
  )
}

/** Marks the code used by `developerId`; false when another registration got there first. */
export function claimInvite(
  db: Database.Database,
  code: string,
  developerId: string,
  now: number,
): boolean {
  return (
    db
      .prepare(
        `UPDATE invites SET used_by = ?, used_at = ? WHERE code_hash = ? AND used_by IS NULL
        AND revoked_at IS NULL AND expires_at > ?`,
      )
      .run(developerId, now, inviteHash(code), now).changes === 1
  )
}

export function revokeInvite(db: Database.Database, id: string, now: number): void {
  const invite = db.prepare('SELECT used_by, revoked_at FROM invites WHERE id = ?').get(id) as
    | { used_by: string | null; revoked_at: number | null }
    | undefined
  if (!invite) throw new HttpError(404, '邀请码不存在')
  if (invite.used_by) throw new HttpError(409, '邀请码已被使用，不能撤销')
  if (invite.revoked_at === null)
    db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(now, id)
}

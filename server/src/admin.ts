import type Database from 'better-sqlite3'
import { INVITE_NOTE_MAX, createInvite, inviteDays } from './invites.js'
import { HttpError } from './validation.js'

export function promoteAdmin(db: Database.Database, email: string): void {
  const result = db
    .prepare(
      `UPDATE developers SET admin = 1
    WHERE email = ? AND password_hash IS NOT NULL`,
    )
    .run(email.trim().toLowerCase())
  if (!result.changes) throw new HttpError(404, '开发者不存在，请先注册')
}

const USAGE = `用法：
  node dist/main.js admin <email>              把已注册的开发者设为管理员
  node dist/main.js invite [--days=N] [备注]    生成一个开发者邀请码（默认 14 天有效）`

/**
 * Parses a maintenance command run on the server. `invite` is how the first developer gets in
 * before any administrator exists; afterwards administrators issue codes on the review page.
 */
export function adminCommand(
  args: string[],
  now: () => number = Date.now,
): (db: Database.Database) => string {
  const [command, ...rest] = args
  if (command === 'admin' && rest.length === 1 && rest[0].trim()) {
    return (db) => {
      promoteAdmin(db, rest[0])
      return '已设为管理员'
    }
  }
  if (command === 'invite') {
    const days = rest.find((arg) => arg.startsWith('--days='))
    const note = rest
      .filter((arg) => arg !== days)
      .join(' ')
      .trim()
    if (!/^(--days=\d{1,3})?$/.test(days ?? '') || Array.from(note).length > INVITE_NOTE_MAX)
      throw new Error(USAGE)
    const validDays = inviteDays(days ? Number(days.slice(7)) : undefined)
    return (db) => {
      const { code, invite } = createInvite(db, { now: now(), days: validDays, note })
      const until = new Date(invite.expiresAt).toISOString().slice(0, 10)
      return `邀请码：${code}\n有效期至 ${until}（UTC），只能注册一个开发者账号。平台只保存它的哈希，请现在发给对方。`
    }
  }
  throw new Error(USAGE)
}

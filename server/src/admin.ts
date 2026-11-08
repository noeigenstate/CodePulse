import type Database from 'better-sqlite3'
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

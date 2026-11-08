import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { FastifyRequest } from 'fastify'
import { HttpError } from './validation.js'
import type { Developer } from './db.js'

export const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex')
export const randomToken = (): string => randomBytes(32).toString('base64url')

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${(await derive(password, salt)).toString('hex')}`
}

export async function checkPassword(password: string, hash: string | null): Promise<boolean> {
  const [salt, expected] = (hash ?? 'unavailable:').split(':')
  const actual = await derive(password, salt)
  const target = Buffer.from(expected, 'hex')
  return target.length === actual.length && timingSafeEqual(target, actual)
}

export class Auth {
  constructor(
    private db: Database.Database,
    private now: () => number,
  ) {}

  session(
    kind: 'developer' | 'store' | 'store-code',
    subject: string,
  ): { token: string; expiresAt: number } {
    const ttl = kind === 'developer' ? 7 * 86400000 : kind === 'store' ? 12 * 3600000 : 60000
    const token = randomToken()
    const expiresAt = this.now() + ttl
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(this.now())
    this.db
      .prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)')
      .run(tokenHash(token), kind, subject, expiresAt)
    return { token, expiresAt }
  }

  bearer(request: FastifyRequest): string {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')
    if (!match) throw new HttpError(401, '请先登录')
    return match[1]
  }

  client(request: FastifyRequest): string {
    const client = this.db
      .prepare('SELECT id FROM clients WHERE token_hash = ?')
      .get(tokenHash(this.bearer(request))) as { id: string } | undefined
    if (!client) throw new HttpError(401, '客户端凭据已失效')
    this.db.prepare('UPDATE clients SET last_seen_at = ? WHERE id = ?').run(this.now(), client.id)
    return client.id
  }

  subject(request: FastifyRequest, kind: 'store' | 'developer'): string {
    const session = this.db
      .prepare('SELECT subject FROM sessions WHERE token_hash = ? AND kind = ? AND expires_at > ?')
      .get(tokenHash(this.bearer(request)), kind, this.now()) as { subject: string } | undefined
    if (!session) throw new HttpError(401, '登录已失效')
    return session.subject
  }

  developer(request: FastifyRequest): Developer {
    const developer = this.db
      .prepare('SELECT * FROM developers WHERE id = ?')
      .get(this.subject(request, 'developer')) as Developer | undefined
    if (!developer || !developer.password_hash) throw new HttpError(401, '登录已失效')
    return developer
  }

  publicDeveloper(developer: Developer): { email: string; name: string; admin: boolean } {
    return { email: developer.email, name: developer.name, admin: developer.admin === 1 }
  }

  admin(request: FastifyRequest): Developer {
    const developer = this.developer(request)
    if (developer.admin !== 1) throw new HttpError(403, '需要管理员权限')
    return developer
  }

  exchangeCode(code: string): { token: string; expiresAt: number } {
    return this.db.transaction(() => {
      const deleted = this.db
        .prepare(
          `DELETE FROM sessions
        WHERE token_hash = ? AND kind = 'store-code' AND expires_at > ? RETURNING subject`,
        )
        .get(tokenHash(code), this.now()) as { subject: string } | undefined
      if (!deleted) throw new HttpError(401, '商店连接码已失效')
      return this.session('store', deleted.subject)
    })()
  }
}

export class RateLimiter {
  private buckets = new Map<string, { expiresAt: number; count: number }>()
  private nextSweep = 0

  constructor(private now: () => number) {}

  check(key: string, limit: number, windowMs = 60000): void {
    const now = this.now()
    if (now >= this.nextSweep) {
      for (const [id, bucket] of this.buckets) {
        if (bucket.expiresAt <= now) this.buckets.delete(id)
      }
      this.nextSweep = now + 60000
    }
    let bucket = this.buckets.get(key)
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { expiresAt: now + windowMs, count: 0 }
      this.buckets.set(key, bucket)
    }
    if (++bucket.count > limit) throw new HttpError(429, '请求太频繁，请稍后再试')
  }
}

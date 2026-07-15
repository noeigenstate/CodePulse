/**
 * 本机 loopback 服务的共享密钥：阻止其它进程随便灌事件。
 *
 * Token 写在用户主目录 `~/.codepulse/local-auth`（仅本机可读），
 * Hook 与 HTTP/WS 客户端共用。
 *
 * @module local-server/local-auth
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const LOCAL_AUTH_HEADER = 'x-codepulse-token'
export const LOCAL_AUTH_QUERY = 'token'

/** 默认本机 token 文件路径。 */
export function defaultLocalAuthPath(home = homedir()): string {
  return join(home, '.codepulse', 'local-auth')
}

/** 生成 32 字节 hex token。 */
export function generateLocalAuthToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * 读取已有 token；不存在则创建并写入。
 * Windows 上 chmod 可能无效，仍尽量写入受限目录。
 */
export function loadOrCreateLocalAuthToken(filePath = defaultLocalAuthPath()): string {
  try {
    const existing = readFileSync(filePath, 'utf8').trim()
    if (existing.length >= 16) return existing
  } catch {
    // create
  }
  const token = generateLocalAuthToken()
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', flag: 'w' })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows may not support posix mode bits.
  }
  return token
}

export function readLocalAuthToken(filePath = defaultLocalAuthPath()): string | undefined {
  try {
    const value = readFileSync(filePath, 'utf8').trim()
    return value.length >= 16 ? value : undefined
  } catch {
    return undefined
  }
}

/** 从请求头 / query 提取 token。 */
export function extractRequestToken(request: FastifyRequest): string | undefined {
  const header = request.headers[LOCAL_AUTH_HEADER]
  if (typeof header === 'string' && header.trim()) return header.trim()
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim()

  const auth = request.headers.authorization
  if (typeof auth === 'string') {
    const match = auth.match(/^Bearer\s+(.+)$/i)
    if (match?.[1]?.trim()) return match[1].trim()
  }

  const query = request.query as Record<string, unknown> | undefined
  const q = query?.[LOCAL_AUTH_QUERY]
  if (typeof q === 'string' && q.trim()) return q.trim()
  return undefined
}

/**
 * 注册本机 token 校验。`/api/health` 保持匿名以便存活探针。
 */
export function registerLocalAuthGuard(app: FastifyInstance, token: string): void {
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url
    if (path === '/api/health') return
    if (tokensMatch(extractRequestToken(request), token)) return
    return rejectUnauthorized(reply)
  })
}

function tokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided || provided.length !== expected.length) return false
  // Constant-time compare for equal-length secrets.
  let diff = 0
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}

function rejectUnauthorized(reply: FastifyReply): void {
  reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid CodePulse local token' })
}

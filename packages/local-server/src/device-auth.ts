/** 局域网设备服务专用认证；与本机 Hook token 完全隔离。 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

export const DEVICE_AUTH_HEADER = 'x-codepulse-device-token'
const DEVICE_HEALTH_PATH = '/api/v1/device/health'
const MIN_DEVICE_TOKEN_LENGTH = 16

/** 默认设备 token 文件路径。 */
export function defaultDeviceAuthPath(home = homedir()): string {
  return join(home, '.codepulse', 'device-auth')
}

/** 生成 32 字节 hex 设备 token。 */
export function generateDeviceAuthToken(): string {
  return randomBytes(32).toString('hex')
}

/** 读取已有设备 token；不存在或内容无效时创建一个新 token。 */
export function loadOrCreateDeviceAuthToken(filePath = defaultDeviceAuthPath()): string {
  const existing = readDeviceAuthToken(filePath)
  if (existing) return existing

  const token = generateDeviceAuthToken()
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${token}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows 不支持 POSIX mode；仍由用户目录 ACL 保护。
  }
  return token
}

/** 从指定文件读取有效设备 token。 */
export function readDeviceAuthToken(filePath = defaultDeviceAuthPath()): string | undefined {
  try {
    const value = readFileSync(filePath, 'utf8').trim()
    return isValidDeviceAuthToken(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 校验显式配置的 token，避免意外使用过短口令。 */
export function assertValidDeviceAuthToken(token: string): string {
  const normalized = token.trim()
  if (!isValidDeviceAuthToken(normalized)) {
    throw new Error(
      `CodePulse device token must contain at least ${MIN_DEVICE_TOKEN_LENGTH} characters`,
    )
  }
  return normalized
}

/** 仅从专用请求头或 Bearer 认证读取 token；有意不支持 URL query。 */
export function extractDeviceRequestToken(request: FastifyRequest): string | undefined {
  const header = request.headers[DEVICE_AUTH_HEADER]
  if (typeof header === 'string' && header.trim()) return header.trim()
  if (Array.isArray(header) && header[0]?.trim()) return header[0].trim()

  const authorization = request.headers.authorization
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return undefined
}

/** 健康检查匿名，其余设备服务请求全部要求设备 token。 */
export function registerDeviceAuthGuard(app: FastifyInstance, token: string): void {
  const expected = assertValidDeviceAuthToken(token)
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url
    if (path === DEVICE_HEALTH_PATH) return
    if (deviceTokensMatch(extractDeviceRequestToken(request), expected)) return
    rejectUnauthorized(reply)
  })
}

function isValidDeviceAuthToken(token: string): boolean {
  return token.length >= MIN_DEVICE_TOKEN_LENGTH
}

function deviceTokensMatch(provided: string | undefined, expected: string): boolean {
  if (!provided) return false
  const providedBytes = Buffer.from(provided)
  const expectedBytes = Buffer.from(expected)
  return (
    providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes)
  )
}

function rejectUnauthorized(reply: FastifyReply): void {
  reply.code(401).send({
    error: 'unauthorized',
    message: 'Missing or invalid CodePulse device token',
  })
}

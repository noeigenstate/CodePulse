/** Desktop 设备服务的稳定配对身份。 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 默认 serverId 文件路径。 */
export function defaultDeviceServerIdPath(home = homedir()): string {
  return join(home, '.codepulse', 'device-server-id')
}

/** UUID 只使用固件协议允许的 ASCII 字符。 */
export function generateDeviceServerId(): string {
  return randomUUID()
}

/** 校验显式 serverId，避免广播固件无法接受的配对身份。 */
export function assertValidDeviceServerId(serverId: string): string {
  const normalized = serverId.trim()
  if (!SERVER_ID_PATTERN.test(normalized)) {
    throw new Error(
      'CodePulse serverId must be 1-64 ASCII letters, digits, dot, underscore or dash',
    )
  }
  return normalized
}

/** 读取已有的合法 serverId。 */
export function readDeviceServerId(filePath = defaultDeviceServerIdPath()): string | undefined {
  try {
    return assertValidDeviceServerId(readFileSync(filePath, 'utf8'))
  } catch {
    return undefined
  }
}

/** 首次运行生成 UUID；后续启动始终复用同一值。 */
export function loadOrCreateDeviceServerId(filePath = defaultDeviceServerIdPath()): string {
  const existing = readDeviceServerId(filePath)
  if (existing) return existing

  const serverId = generateDeviceServerId()
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  writeFileSync(filePath, `${serverId}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 })
  try {
    chmodSync(filePath, 0o600)
  } catch {
    // Windows 使用用户目录 ACL；POSIX mode 不可用时无需阻止启动。
  }
  return serverId
}

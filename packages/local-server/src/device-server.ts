/** 局域网设备服务：工作状态只读，可显式注册认证的助手专用操作。 */
import Fastify, { type FastifyInstance } from 'fastify'
import {
  DEFAULT_DEVICE_SERVER_HOST,
  DEFAULT_DEVICE_SERVER_PORT,
  DEVICE_PROTOCOL_VERSION,
  type DeviceDisplayConfig,
  type DeviceStatusV1,
  type StatusSnapshot,
} from '@codepulse/shared'
import { toDeviceStatusV1, type StatusHub } from '@codepulse/core'
import {
  assertValidDeviceAuthToken,
  defaultDeviceAuthPath,
  loadOrCreateDeviceAuthToken,
  registerDeviceAuthGuard,
} from './device-auth.js'
import {
  publishDeviceMdns,
  type DeviceMdnsPublisher,
  type DeviceMdnsPublisherOptions,
} from './device-discovery.js'
import {
  assertValidDeviceServerId,
  defaultDeviceServerIdPath,
  loadOrCreateDeviceServerId,
} from './device-server-id.js'

export const DEVICE_STATUS_PATH = '/api/v1/device/status'
export const DEVICE_HEALTH_PATH = '/api/v1/device/health'

export const DEVICE_SERVER_ENABLED_ENV = 'CODEPULSE_DEVICE_SERVER_ENABLED'
export const DEVICE_SERVER_HOST_ENV = 'CODEPULSE_DEVICE_SERVER_HOST'
export const DEVICE_SERVER_PORT_ENV = 'CODEPULSE_DEVICE_SERVER_PORT'
export const DEVICE_SERVER_TOKEN_ENV = 'CODEPULSE_DEVICE_TOKEN'

/** 从环境变量解析出的局域网服务设置。 */
export interface DeviceServerConfig {
  enabled: boolean
  host: string
  port: number
  authToken?: string
}

/** {@link startDeviceServer} 选项。 */
export interface DeviceServerOptions {
  /** Optional local assistant endpoints. Omitted hosts retain the read-only contract. */
  registerAssistantRoutes?: (app: FastifyInstance) => void | Promise<void>
  /** Optional host presentation projection, shared with desktop configuration previews. */
  projectStatus?: (snapshot: StatusSnapshot, config?: DeviceDisplayConfig) => DeviceStatusV1
  getDisplayConfig?: () => DeviceDisplayConfig
  hub: StatusHub
  host?: string
  port?: number
  logger?: boolean
  authToken?: string
  authTokenPath?: string
  serverId?: string
  serverIdPath?: string
  /** 测试或诊断时可关闭广播；生产默认开启。 */
  publishMdns?: boolean
  mdns?: DeviceMdnsPublisherOptions['mdns']
  onMdnsError?: (message: string) => void
}

/** 一个运行中的局域网设备服务器。 */
export interface DeviceServer {
  app: FastifyInstance
  url: string
  port: number
  authToken: string
  authTokenPath?: string
  serverId: string
  serverIdPath?: string
  mdns?: DeviceMdnsPublisher
  /** Wake waiting readers after a saved display configuration change. */
  notifyChanged: () => void
  close: () => Promise<void>
}

/**
 * 解析 Electron 进程环境。服务默认关闭，只有明确设置 true/1/on/yes 才启用。
 * 无效端口回落到 17889，避免因为拼写问题破坏桌面端启动。
 */
export function readDeviceServerConfig(
  env: Record<string, string | undefined> = process.env,
): DeviceServerConfig {
  const rawPort = env[DEVICE_SERVER_PORT_ENV]?.trim()
  const parsedPort = rawPort ? Number(rawPort) : DEFAULT_DEVICE_SERVER_PORT
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65_535
      ? parsedPort
      : DEFAULT_DEVICE_SERVER_PORT
  const rawToken = env[DEVICE_SERVER_TOKEN_ENV]?.trim()

  return {
    enabled: /^(1|true|yes|on)$/i.test(env[DEVICE_SERVER_ENABLED_ENV]?.trim() ?? ''),
    host: env[DEVICE_SERVER_HOST_ENV]?.trim() || DEFAULT_DEVICE_SERVER_HOST,
    port,
    ...(rawToken ? { authToken: rawToken } : {}),
  }
}

/**
 * 启动只包含健康检查和状态读取的局域网服务。
 *
 * 该服务与 127.0.0.1:17888 的 Hook API 分离，局域网客户端无法写事件、
 * 确认任务。
 */
export async function startDeviceServer(options: DeviceServerOptions): Promise<DeviceServer> {
  const host = options.host ?? DEFAULT_DEVICE_SERVER_HOST
  const port = options.port ?? DEFAULT_DEVICE_SERVER_PORT
  const authTokenPath = options.authToken
    ? undefined
    : (options.authTokenPath ?? defaultDeviceAuthPath())
  const authToken = options.authToken
    ? assertValidDeviceAuthToken(options.authToken)
    : loadOrCreateDeviceAuthToken(authTokenPath)
  const serverIdPath = options.serverId
    ? undefined
    : (options.serverIdPath ?? defaultDeviceServerIdPath())
  const serverId = options.serverId
    ? assertValidDeviceServerId(options.serverId)
    : loadOrCreateDeviceServerId(serverIdPath)

  const app = Fastify({ logger: options.logger ?? false })
  registerDeviceAuthGuard(app, authToken)
  if (options.registerAssistantRoutes) await options.registerAssistantRoutes(app)

  app.get(DEVICE_HEALTH_PATH, async (_request, reply) => {
    reply.header('x-codepulse-protocol-version', String(DEVICE_PROTOCOL_VERSION))
    return {
      ok: true,
      service: 'codepulse-device',
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      ts: Date.now(),
    }
  })

  // A bounded, authenticated read-only watch. Register before reading the
  // snapshot so a transition cannot fall between the comparison and listener.
  const readers = new Set<() => void>()
  let stopped = false
  const notifyChanged = () => { for (const wake of [...readers]) wake() }
  options.hub.on('status', notifyChanged)
  app.addHook('preClose', async () => {
    stopped = true
    options.hub.off('status', notifyChanged)
    notifyChanged()
  })
  const snapshot = () => (options.projectStatus ?? toDeviceStatusV1)(options.hub.snapshot(), options.getDisplayConfig?.())

  app.get(DEVICE_STATUS_PATH, async (request, reply) => {
    const rawWait = request.headers['x-codepulse-wait-ms']
    const waitMs = rawWait === undefined ? 0 : Number(rawWait)
    if (typeof rawWait === 'object' || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 1000)
      return reply.code(400).send({ error: 'invalid_wait', maxWaitMs: 1000 })
    let status = snapshot()
    const conditional = request.headers['if-none-match']
    if (waitMs && etagMatches(conditional, `W/"${status.revision}"`)) {
      if (readers.size >= 32) return reply.code(503).send({ error: 'too_many_readers' })
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: unknown) => {
          clearTimeout(timer)
          readers.delete(wake)
          reply.raw.off('close', onClose)
          if (error) reject(error); else resolve()
        }
        const wake = () => {
          try {
            if (stopped) { finish(); return }
            status = snapshot()
            if (!etagMatches(conditional, `W/"${status.revision}"`)) finish()
          } catch (error) { finish(error) }
        }
        const onClose = () => finish()
        const timer = setTimeout(() => finish(), waitMs)
        readers.add(wake)
        reply.raw.once('close', onClose)
        wake()
        if (reply.raw.destroyed) finish()
      })
    }
    if (reply.raw.destroyed) { reply.hijack(); return reply }
    if (stopped) return reply.code(503).send({ error: 'server_closing' })
    // Re-read after the await: merge changes received during the same turn.
    status = snapshot()
    const etag = `W/"${status.revision}"`
    reply.header('x-codepulse-protocol-version', String(DEVICE_PROTOCOL_VERSION))
    reply.header('cache-control', 'private, no-cache, max-age=0, must-revalidate')
    reply.header('etag', etag)
    if (etagMatches(conditional, etag)) return reply.code(304).send()
    return status
  })

  try {
    await app.listen({ host, port })
  } catch (error) {
    try {
      await app.close()
    } catch {
      // ignore cleanup failure and preserve the original bind error
    }
    throw error
  }

  const address = app.server.address()
  const boundPort = address && typeof address !== 'string' ? address.port : port
  const urlHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  let mdns: DeviceMdnsPublisher | undefined
  if (options.publishMdns !== false) {
    try {
      mdns = publishDeviceMdns({
        serverId,
        port: boundPort,
        statusPath: DEVICE_STATUS_PATH,
        ...(options.mdns ? { mdns: options.mdns } : {}),
        ...(options.onMdnsError ? { onError: options.onMdnsError } : {}),
      })
    } catch (error) {
      options.onMdnsError?.(
        error instanceof Error ? error.message : 'Unable to publish the device API over mDNS',
      )
    }
  }

  let closing: Promise<void> | undefined

  return {
    app,
    url: `http://${urlHost}:${boundPort}`,
    port: boundPort,
    authToken,
    authTokenPath,
    serverId,
    serverIdPath,
    mdns,
    notifyChanged,
    close: () => {
      if (closing) return closing
      closing = (async () => {
        await mdns?.close()
        await app.close()
      })()
      return closing
    },
  }
}

function etagMatches(header: string | string[] | undefined, expected: string): boolean {
  const values = Array.isArray(header) ? header : header ? [header] : []
  return values.some((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .some((item) => item === '*' || item === expected || item === expected.slice(2)),
  )
}

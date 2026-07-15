/**
 * `@codepulse/local-server` —— 接收 hook 事件并暴露当前状态的
 * 回环 HTTP + WebSocket 服务（需求 §5.9）。
 *
 * @module local-server
 */
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import { registerAgentRoutes } from './routes/agents.js'
import { registerEventRoutes } from './routes/events.js'
import { registerStatusRoutes } from './routes/status.js'
import { QuotaRefreshWatcher } from './quota-watcher.js'
import { SessionSyncService } from './session-sync.js'
import { registerWebSocket } from './websocket/index.js'
import {
  defaultLocalAuthPath,
  loadOrCreateLocalAuthToken,
  registerLocalAuthGuard,
} from './local-auth.js'

/**
 * {@link startLocalServer} 的选项。
 */
export interface LocalServerOptions {
  /** 服务器读取状态并投喂事件的状态 hub。 */
  hub: StatusHub
  /** 绑定主机（默认回环地址 `127.0.0.1`）。 */
  host?: string
  /** 绑定端口（默认 `17888`）。 */
  port?: number
  /** 启用 Fastify 请求日志（默认关闭）。 */
  logger?: boolean
  /** 禁用本机 CLI 会话主动扫描（测试用）。 */
  disableSessionSync?: boolean
  /**
   * 本机 API 认证：
   * - 省略：生成/复用 `~/.codepulse/local-auth` 中的 token（生产默认）
   * - string：使用给定 token
   * - false：关闭认证（仅测试）
   */
  authToken?: string | false
  /** 覆盖 local-auth 文件路径（测试）。 */
  authTokenPath?: string
}

/**
 * 一个运行中的本地服务器实例。
 */
export interface LocalServer {
  /** 底层 Fastify 实例。 */
  app: FastifyInstance
  /** 服务器监听的基础 URL。 */
  url: string
  /** 本机 API token；auth 关闭时为 undefined。 */
  authToken?: string
  /** 立即再扫一轮本机 CLI 会话（窗口聚焦时调用）。 */
  syncSessions: () => Promise<void>
  /** 停止服务器并释放端口。 */
  close: () => Promise<void>
}

/**
 * 构建并启动本地 HTTP + WebSocket 服务（需求 §5.9）。
 *
 * 默认仅绑定回环地址，绝不暴露到网络。针对给定的 hub
 * 注册 WebSocket 通道与事件/状态路由。
 *
 * @param options hub 加可选的主机/端口/日志覆盖项。
 * @returns 运行中的服务器、其 URL 及 `close` 函数。
 * @throws 端口绑定失败时抛出（调用方不得再配置 Hook）。
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST
  const port = options.port ?? DEFAULT_SERVER_PORT

  const authToken =
    options.authToken === false
      ? undefined
      : typeof options.authToken === 'string'
        ? options.authToken
        : loadOrCreateLocalAuthToken(options.authTokenPath ?? defaultLocalAuthPath())

  const app = Fastify({ logger: options.logger ?? false })

  if (authToken) {
    registerLocalAuthGuard(app, authToken)
  }

  await app.register(websocket)
  const quotaWatcher = new QuotaRefreshWatcher({
    hub: options.hub,
    // Production: keep re-reading bound rollouts after reset / idle wait.
    // Tests inject their own watcher options via direct construction.
  })
  const onHubEvent = (event: Parameters<typeof quotaWatcher.observe>[0]): void => {
    quotaWatcher.observe(event)
  }
  options.hub.on('event', onHubEvent)

  const sessionSync = options.disableSessionSync
    ? undefined
    : new SessionSyncService({ hub: options.hub })
  // Await first disk scan so the main process can open the window with
  // already-hydrated projects (no need for the user to start a chat first).
  if (sessionSync) await sessionSync.start()

  registerWebSocket(app, options.hub)
  registerAgentRoutes(app)
  registerEventRoutes(app, options.hub)
  registerStatusRoutes(app, options.hub)

  try {
    await app.listen({ host, port })
  } catch (err) {
    sessionSync?.stop()
    quotaWatcher.stop()
    options.hub.off('event', onHubEvent)
    try {
      await app.close()
    } catch {
      // ignore
    }
    throw err
  }

  return {
    app,
    url: `http://${host}:${port}`,
    authToken,
    syncSessions: async () => {
      await sessionSync?.syncNow()
    },
    close: async () => {
      sessionSync?.stop()
      quotaWatcher.stop()
      options.hub.off('event', onHubEvent)
      await app.close()
    },
  }
}

export {
  commandCandidates,
  detectAgents,
  detectClaudeAgent,
  detectCodexAgent,
  detectGrokAgent,
  type AgentDetectOptions,
} from './agent-detect.js'
export {
  configureAgents,
  configureClaudeAgent,
  configureCodexAgent,
  configureGrokAgent,
  cleanupAgents,
  cleanupClaudeAgent,
  cleanupCodexAgent,
  cleanupGrokAgent,
  publishStableHookLaunchers,
  type AgentConfigurationOptions,
  type AgentConfigurationResult,
  type AgentConfigurationStatus,
} from './agent-config.js'
export { registerAgentRoutes, registerEventRoutes, registerStatusRoutes, registerWebSocket }
export { QuotaRefreshWatcher, readCodexQuotaTokenFromFile } from './quota-watcher.js'
export { SessionSyncService, type SessionSyncOptions } from './session-sync.js'
export {
  defaultLocalAuthPath,
  generateLocalAuthToken,
  loadOrCreateLocalAuthToken,
  readLocalAuthToken,
  LOCAL_AUTH_HEADER,
  LOCAL_AUTH_QUERY,
} from './local-auth.js'

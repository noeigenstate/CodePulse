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
import { registerWebSocket } from './websocket/index.js'

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
}

/**
 * 一个运行中的本地服务器实例。
 */
export interface LocalServer {
  /** 底层 Fastify 实例。 */
  app: FastifyInstance
  /** 服务器监听的基础 URL。 */
  url: string
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
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST
  const port = options.port ?? DEFAULT_SERVER_PORT

  const app = Fastify({ logger: options.logger ?? false })

  await app.register(websocket)
  registerWebSocket(app, options.hub)
  registerAgentRoutes(app)
  registerEventRoutes(app, options.hub)
  registerStatusRoutes(app, options.hub)

  await app.listen({ host, port })

  return {
    app,
    url: `http://${host}:${port}`,
    close: () => app.close(),
  }
}

export {
  detectAgents,
  detectClaudeAgent,
  detectCodexAgent,
  type AgentDetectOptions,
} from './agent-detect.js'
export { registerAgentRoutes, registerEventRoutes, registerStatusRoutes, registerWebSocket }

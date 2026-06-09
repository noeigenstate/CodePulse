/**
 * `@codepulse/local-server` — the loopback HTTP + WebSocket service that
 * receives hook events and exposes current status (requirements §5.9).
 *
 * @module local-server
 */
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import { registerEventRoutes } from './routes/events.js'
import { registerStatusRoutes } from './routes/status.js'
import { registerWebSocket } from './websocket/index.js'

/**
 * Options for {@link startLocalServer}.
 */
export interface LocalServerOptions {
  /** The status hub the server reads from and feeds events into. */
  hub: StatusHub
  /** Bind host (defaults to loopback `127.0.0.1`). */
  host?: string
  /** Bind port (defaults to `17888`). */
  port?: number
  /** Enable Fastify's request logger (default off). */
  logger?: boolean
}

/**
 * A running local server instance.
 */
export interface LocalServer {
  /** The underlying Fastify instance. */
  app: FastifyInstance
  /** The base URL the server is listening on. */
  url: string
  /** Stops the server and releases the port. */
  close: () => Promise<void>
}

/**
 * Builds and starts the local HTTP + WebSocket service (requirements §5.9).
 *
 * Binds to loopback only by default so it is never exposed to the network.
 * Registers the WebSocket channel and the event/status routes against the
 * provided hub.
 *
 * @param options The hub plus optional host/port/logger overrides.
 * @returns The running server, its URL, and a `close` function.
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST
  const port = options.port ?? DEFAULT_SERVER_PORT

  const app = Fastify({ logger: options.logger ?? false })

  await app.register(websocket)
  registerWebSocket(app, options.hub)
  registerEventRoutes(app, options.hub)
  registerStatusRoutes(app, options.hub)

  await app.listen({ host, port })

  return {
    app,
    url: `http://${host}:${port}`,
    close: () => app.close(),
  }
}

export { registerEventRoutes, registerStatusRoutes, registerWebSocket }

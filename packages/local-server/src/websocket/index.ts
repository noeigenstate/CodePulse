/**
 * The WebSocket push channel: `GET /ws`. Streams status snapshots and
 * notifications to connected clients (the renderer Dashboard today, an ESP32
 * bridge tomorrow).
 *
 * @module local-server/websocket
 */
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { NotificationRequest, ServerPushMessage, StatusSnapshot } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'

/**
 * Registers the `GET /ws` WebSocket route and bridges hub events to it.
 *
 * Subscribes to the hub's `status` and `notification` events and fans them out
 * to every connected socket. On connect, the current snapshot is sent
 * immediately so a late client is never blank. Hub listeners and sockets are
 * cleaned up on server close.
 *
 * @param app The Fastify instance (must have `@fastify/websocket` registered).
 * @param hub The status hub to relay events from.
 */
export function registerWebSocket(app: FastifyInstance, hub: StatusHub): void {
  const clients = new Set<WebSocket>()

  const onStatus = (snapshot: StatusSnapshot) =>
    broadcast(clients, { type: 'status', payload: snapshot })
  const onNotification = (note: NotificationRequest) =>
    broadcast(clients, { type: 'notification', payload: note })

  hub.on('status', onStatus)
  hub.on('notification', onNotification)

  app.get('/ws', { websocket: true }, (socket) => {
    clients.add(socket)
    send(socket, { type: 'status', payload: hub.snapshot() })

    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })

  app.addHook('onClose', async () => {
    hub.off('status', onStatus)
    hub.off('notification', onNotification)
    for (const client of clients) client.close()
    clients.clear()
  })
}

/**
 * Sends a message to every open client socket.
 *
 * @param clients The set of connected sockets.
 * @param message The push message to serialize and send.
 */
function broadcast(clients: Set<WebSocket>, message: ServerPushMessage): void {
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data)
  }
}

/**
 * Sends a single message to one socket if it is open.
 *
 * @param socket The target socket.
 * @param message The push message to serialize and send.
 */
function send(socket: WebSocket, message: ServerPushMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

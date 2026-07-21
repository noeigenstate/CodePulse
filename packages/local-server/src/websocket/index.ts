/**
 * WebSocket 推送通道：`GET /ws`。向已连接客户端流式推送状态快照与
 * 通知（今天是渲染端 Dashboard，将来是 ESP32 桥接）。
 *
 * @module local-server/websocket
 */
import type { FastifyInstance } from 'fastify'
import type { WebSocket } from '@fastify/websocket'
import type { NotificationRequest, ServerPushMessage, StatusSnapshot } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'

/**
 * 注册 `GET /ws` WebSocket 路由，并把 hub 事件桥接过去。
 *
 * 订阅 hub 的 `status` 与 `notification` 事件并扇出到每个已连接
 * socket。连接建立时立即发送当前快照，保证晚到的客户端不会空白。
 * 服务器关闭时清理 hub 监听器与 socket。
 *
 * @param app Fastify 实例（必须已注册 `@fastify/websocket`）。
 * @param hub 事件来源的状态 hub。
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
 * 向每个打开的客户端 socket 发送消息。
 *
 * @param clients 已连接 socket 的集合。
 * @param message 待序列化并发送的推送消息。
 */
function broadcast(clients: Set<WebSocket>, message: ServerPushMessage): void {
  // The Electron renderer uses IPC, so most desktop sessions have no WebSocket
  // clients. Avoid serializing every hook-driven status snapshot in that common case.
  if (clients.size === 0) return
  const data = JSON.stringify(message)
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(data)
  }
}

/**
 * 若 socket 处于打开状态，向其发送单条消息。
 *
 * @param socket 目标 socket。
 * @param message 待序列化并发送的推送消息。
 */
function send(socket: WebSocket, message: ServerPushMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

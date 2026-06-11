/**
 * 状态与控制路由：读取当前状态、硬件投影、确认结果、切换静音，
 * 以及健康探针。
 *
 * @module local-server/routes/status
 */
import type { FastifyInstance } from 'fastify'
import { toDeviceStatus, type StatusHub } from '@codepulse/core'
import type { AgentType } from '@codepulse/shared'

/**
 * 注册读取/控制路由：
 *
 * - `GET /api/status` —— Dashboard 用的完整 {@link StatusSnapshot}。
 * - `GET /api/device/status` —— 硬件用的极简 {@link DeviceStatus}。
 * - `POST /api/ack/:agent` —— 把 agent 的终结结果标记为已读。
 * - `POST /api/mute` —— `{ muted }` 切换通知声音。
 * - `GET /api/health` —— 存活探针。
 *
 * @param app 注册路由的 Fastify 实例。
 * @param hub 读取与控制的状态 hub。
 */
export function registerStatusRoutes(app: FastifyInstance, hub: StatusHub): void {
  app.get('/api/status', async () => hub.snapshot())

  app.get('/api/device/status', async () => toDeviceStatus(hub.snapshot()))

  app.post<{ Params: { agent: AgentType } }>('/api/ack/:agent', async (request) => {
    hub.acknowledge(request.params.agent)
    return { ok: true }
  })

  app.post<{ Body: { muted?: boolean } }>('/api/mute', async (request) => {
    const muted = Boolean(request.body?.muted)
    hub.setMuted(muted)
    return { ok: true, muted }
  })

  app.get('/api/health', async () => ({ ok: true, ts: Date.now() }))
}

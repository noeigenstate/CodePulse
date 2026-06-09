/**
 * Status and control routes: reading current status, the hardware projection,
 * acknowledging results, toggling mute, and a health probe.
 *
 * @module local-server/routes/status
 */
import type { FastifyInstance } from 'fastify'
import { toDeviceStatus, type StatusHub } from '@codepulse/core'
import type { AgentType } from '@codepulse/shared'

/**
 * Registers the read/control routes:
 *
 * - `GET /api/status` — full {@link StatusSnapshot} for the Dashboard.
 * - `GET /api/device/status` — minimal {@link DeviceStatus} for hardware.
 * - `POST /api/ack/:agent` — mark an agent's terminal result as read.
 * - `POST /api/mute` — `{ muted }` to toggle notification sound.
 * - `GET /api/health` — liveness probe.
 *
 * @param app The Fastify instance to register the routes on.
 * @param hub The status hub to read from and control.
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

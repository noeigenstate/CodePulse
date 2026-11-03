import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WorkVoiceDelivery } from './work-voice-delivery.js'

/** Must be registered behind the existing device authentication guard. */
export function registerWorkVoiceRoutes(app: FastifyInstance, delivery: WorkVoiceDelivery): void {
  const prefix = '/api/v1/device/work/voice'
  const device = (request: FastifyRequest) => {
    const value = request.headers['x-codepulse-device-id']
    if (typeof value !== 'string' || !/^[-A-Za-z0-9_:]{1,64}$/.test(value)) throw Error('device')
    return value
  }
  app.get(prefix, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    try {
      return { announcement: delivery.claim(device(request)) }
    } catch {
      return reply.code(429).send({ error: 'Work voice device unavailable' })
    }
  })
  app.get<{ Params: { id: string } }>(prefix + '/:id/audio', async (request, reply) => {
    reply.header('cache-control', 'no-store')
    try {
      const pcm = await delivery.audio(device(request), request.params.id)
      return reply
        .type('application/octet-stream')
        .header('x-codepulse-audio-rate', '16000')
        .header('x-codepulse-audio-format', 'pcm_s16le')
        .send(Buffer.from(pcm))
    } catch {
      return reply.code(410).send({ error: 'Work voice unavailable or no longer relevant' })
    }
  })
  app.post<{ Params: { id: string } }>(
    prefix + '/:id/ack',
    { bodyLimit: 128 },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      try {
        delivery.acknowledge(device(request), request.params.id)
        return { ok: true }
      } catch {
        return reply.code(410).send({ error: 'Work voice delivery expired' })
      }
    },
  )
}

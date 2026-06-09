/**
 * The event-ingestion route: `POST /api/events`. This is the entry point hook
 * scripts call to report agent activity.
 *
 * @module local-server/routes/events
 */
import type { FastifyInstance } from 'fastify'
import { normalizeEvent, type StatusHub } from '@codepulse/core'
import { normalizeRawEvent } from '@codepulse/adapters'

/**
 * Registers `POST /api/events`.
 *
 * Accepts either a single raw hook payload or an array of them. Each item is
 * run through the adapters (`normalizeRawEvent`) and the normalizer
 * (`normalizeEvent`) and fed to the hub. Unrecognised items are counted and
 * ignored rather than failing the whole request. Responds `202` if at least one
 * event was accepted, otherwise `400`.
 *
 * @param app The Fastify instance to register the route on.
 * @param hub The status hub to feed accepted events into.
 */
export function registerEventRoutes(app: FastifyInstance, hub: StatusHub): void {
  app.post('/api/events', async (request, reply) => {
    const body = request.body
    const items = Array.isArray(body) ? body : [body]
    let accepted = 0
    const ignored: unknown[] = []

    for (const item of items) {
      const input = normalizeRawEvent(item)
      if (!input) {
        ignored.push(item)
        continue
      }
      hub.ingest(normalizeEvent(input))
      accepted += 1
    }

    reply.code(accepted > 0 ? 202 : 400)
    return { accepted, ignored: ignored.length }
  })
}

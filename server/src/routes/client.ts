import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { PluginFeed } from '@codepulse/shared'
import { randomToken, tokenHash } from '../auth.js'
import type { Context } from '../context.js'
import { liveVersion } from '../db.js'
import { object, text } from '../validation.js'

export function clientRoutes(app: FastifyInstance, context: Context): void {
  const { db, auth, now, rate, generator } = context
  app.post('/api/v1/clients', async (request) => {
    rate.check(`clients:${request.ip}`, 5)
    const clientId = randomUUID()
    const token = randomToken()
    db.prepare('INSERT INTO clients VALUES (?, ?, ?, ?)').run(
      clientId,
      tokenHash(token),
      now(),
      now(),
    )
    return { clientId, token }
  })

  app.post('/api/v1/clients/store-code', async (request) => {
    rate.check(`store-code:${request.ip}`, 20)
    const { token: code, expiresAt } = auth.session('store-code', auth.client(request))
    return { code, expiresAt }
  })

  app.post('/api/v1/store/session', async (request) => {
    const code = text(object(request.body).code, 100, '连接码')
    return auth.exchangeCode(code)
  })

  app.get('/api/v1/client/cards', async (request): Promise<PluginFeed> => {
    const clientId = auth.client(request)
    rate.check(`cards:${clientId}`, 12)
    const installs = db
      .prepare(
        'SELECT plugin_id, settings_json FROM installs WHERE client_id = ? AND enabled = 1 ORDER BY installed_at, plugin_id',
      )
      .all(clientId) as { plugin_id: string; settings_json: string }[]
    const results = await Promise.all(
      installs.map(async (install) => {
        const version = liveVersion(db, install.plugin_id)
        if (!version) return undefined
        return {
          pluginId: install.plugin_id,
          result: await generator.cached(version, JSON.parse(install.settings_json)),
        }
      }),
    )
    const feed: PluginFeed = {
      v: 1,
      generatedAt: now(),
      nextPollAt: now() + 15 * 60000,
      cards: [],
      errors: {},
    }
    for (const entry of results) {
      if (!entry) continue
      for (const card of entry.result.cards) {
        if (card.expiresAt > now()) feed.cards.push({ ...card, pluginId: entry.pluginId })
      }
      if (entry.result.error) feed.errors[entry.pluginId] = entry.result.error
      feed.nextPollAt = Math.min(feed.nextPollAt, Math.max(now() + 30000, entry.result.expiresAt))
    }
    return feed
  })
}

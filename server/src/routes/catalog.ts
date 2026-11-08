import type { FastifyInstance } from 'fastify'
import type { PluginListing, PluginManifest } from '@codepulse/shared'
import { liveVersion } from '../db.js'
import type { Context } from '../context.js'
import { HttpError, invalid } from '../validation.js'

function catalog(context: Context): PluginListing[] {
  const rows = context.db
    .prepare(
      `SELECT p.id, v.manifest_json, d.name AS developer, v.reviewed_at,
    (SELECT COUNT(*) FROM installs i WHERE i.plugin_id = p.id) AS installs
    FROM plugins p JOIN versions v ON v.id = p.live_version_id
    JOIN developers d ON d.id = p.developer_id WHERE v.state = 'approved' ORDER BY p.created_at, p.id`,
    )
    .all() as {
    id: string
    manifest_json: string
    developer: string
    reviewed_at: number
    installs: number
  }[]
  return rows.map((row) => {
    const m = JSON.parse(row.manifest_json) as PluginManifest
    return {
      id: row.id,
      name: m.name,
      summary: m.summary,
      description: m.description,
      kind: m.kind,
      version: m.version,
      developer: row.developer,
      installs: row.installs,
      settings: m.settings,
      updatedAt: row.reviewed_at,
    }
  })
}

export function catalogRoutes(app: FastifyInstance, context: Context): void {
  app.get<{ Querystring: { q?: string; kind?: string } }>('/api/v1/plugins', async (request) => {
    const { q = '', kind = '' } = request.query
    if (
      typeof q !== 'string' ||
      q.length > 200 ||
      !['', 'builtin', 'pack', 'webhook'].includes(kind)
    )
      invalid('筛选条件无效')
    const needle = q.toLowerCase()
    return {
      plugins: catalog(context).filter(
        (p) =>
          (!kind || p.kind === kind) &&
          `${p.name} ${p.summary} ${p.id}`.toLowerCase().includes(needle),
      ),
    }
  })

  app.get<{ Params: { id: string } }>('/api/v1/plugins/:id', async (request) => {
    const plugin = catalog(context).find((p) => p.id === request.params.id)
    if (!plugin) throw new HttpError(404, '插件不存在')
    return { plugin }
  })

  app.get<{ Params: { id: string } }>('/api/v1/plugins/:id/preview', async (request) => {
    const version = liveVersion(context.db, request.params.id)
    if (!version) throw new HttpError(404, '插件不存在')
    const { cards, error } = await context.generator.cached(version, {})
    return { cards, error }
  })
}

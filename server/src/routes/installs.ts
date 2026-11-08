import type { FastifyInstance } from 'fastify'
import { normalizePluginSettings, type PluginInstall } from '@codepulse/shared'
import type { Context } from '../context.js'
import { liveVersion, manifestOf } from '../db.js'
import { HttpError, invalid, object } from '../validation.js'

interface InstallRow {
  plugin_id: string
  enabled: number
  settings_json: string
  installed_at: number
}
const asInstall = (row: InstallRow): PluginInstall => ({
  pluginId: row.plugin_id,
  enabled: Boolean(row.enabled),
  settings: JSON.parse(row.settings_json),
  installedAt: row.installed_at,
})

export function installRoutes(app: FastifyInstance, context: Context): void {
  const { db, auth, generator, now } = context
  app.get('/api/v1/installs', async (request) => {
    const clientId = auth.subject(request, 'store')
    const rows = db
      .prepare('SELECT * FROM installs WHERE client_id = ? ORDER BY installed_at, plugin_id')
      .all(clientId) as InstallRow[]
    return {
      installs: rows.map((row) => {
        const version = liveVersion(db, row.plugin_id)
        const install = asInstall(row)
        if (version)
          install.settings = normalizePluginSettings(manifestOf(version).settings, install.settings)
        const status = version ? generator.status(version, install.settings) : undefined
        return {
          ...install,
          status: {
            generatedAt: status?.generatedAt ?? null,
            error: version ? (status?.error ?? '') : '插件暂不可用',
          },
        }
      }),
    }
  })

  app.put<{ Params: { id: string } }>('/api/v1/installs/:id', async (request) => {
    const clientId = auth.subject(request, 'store')
    const version = liveVersion(db, request.params.id)
    if (!version) throw new HttpError(404, '插件不存在')
    const body = object(request.body)
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') invalid('启用状态无效')
    if (body.settings !== undefined) object(body.settings)
    const previous = db
      .prepare('SELECT * FROM installs WHERE client_id = ? AND plugin_id = ?')
      .get(clientId, request.params.id) as InstallRow | undefined
    const install: PluginInstall = {
      pluginId: request.params.id,
      enabled: (body.enabled as boolean | undefined) ?? Boolean(previous?.enabled ?? 1),
      settings: normalizePluginSettings(
        manifestOf(version).settings,
        body.settings ?? (previous ? JSON.parse(previous.settings_json) : {}),
      ),
      installedAt: previous?.installed_at ?? now(),
    }
    db.prepare(
      `INSERT INTO installs VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(client_id, plugin_id) DO UPDATE SET enabled=excluded.enabled, settings_json=excluded.settings_json`,
    ).run(
      clientId,
      install.pluginId,
      Number(install.enabled),
      JSON.stringify(install.settings),
      install.installedAt,
    )
    return { install }
  })

  app.delete<{ Params: { id: string } }>('/api/v1/installs/:id', async (request) => {
    db.prepare('DELETE FROM installs WHERE client_id = ? AND plugin_id = ?').run(
      auth.subject(request, 'store'),
      request.params.id,
    )
    return { ok: true }
  })
}

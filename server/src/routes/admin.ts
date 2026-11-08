import type { FastifyInstance } from 'fastify'
import type { PluginManifest } from '@codepulse/shared'
import type { Context } from '../context.js'
import { logoUrl } from '../logo.js'
import { liveVersion } from '../db.js'
import { HttpError, invalid, newerVersion, object, text } from '../validation.js'

export function adminRoutes(app: FastifyInstance, context: Context): void {
  const { db, auth, now } = context
  app.delete<{ Params: { id: string } }>('/api/v1/admin/plugins/:id/logo', async (request) => {
    auth.admin(request)
    if (!db.prepare('SELECT id FROM plugins WHERE id = ?').get(request.params.id))
      throw new HttpError(404, '插件不存在')
    db.prepare('DELETE FROM logos WHERE plugin_id = ?').run(request.params.id)
    return { logoUrl: null }
  })

  app.get('/api/v1/admin/reviews', async (request) => {
    auth.admin(request)
    const rows = db
      .prepare(
        `SELECT v.id AS versionId, p.id AS pluginId, p.name AS pluginName, v.version,
      d.name AS developer, v.submitted_at AS submittedAt, v.manifest_json, v.payload_json, l.hash AS logo_hash
      FROM versions v JOIN plugins p ON p.id = v.plugin_id JOIN developers d ON d.id = p.developer_id
      LEFT JOIN logos l ON l.plugin_id = p.id WHERE v.state = 'pending' ORDER BY v.submitted_at, v.rowid`,
      )
      .all() as {
      versionId: string
      pluginId: string
      pluginName: string
      version: string
      developer: string
      submittedAt: number
      manifest_json: string
      payload_json: string
      logo_hash: string | null
    }[]
    return {
      reviews: rows.map(({ manifest_json, payload_json, logo_hash, ...row }) => {
        const manifest = JSON.parse(manifest_json) as PluginManifest
        const payload = JSON.parse(payload_json) as { cards?: unknown[]; endpoint?: string }
        return {
          ...row,
          logoUrl: logoUrl(row.pluginId, logo_hash),
          kind: manifest.kind,
          cardCount: payload.cards?.length ?? null,
          endpoint: payload.endpoint ?? null,
        }
      }),
    }
  })

  app.post<{ Params: { versionId: string } }>(
    '/api/v1/admin/reviews/:versionId',
    async (request) => {
      auth.admin(request)
      const body = object(request.body)
      if (body.decision !== 'approved' && body.decision !== 'rejected') invalid('审核决定无效')
      const note = body.note === undefined ? '' : text(body.note, 600, '审核备注', true)
      db.transaction(() => {
        const version = db
          .prepare('SELECT plugin_id, state, manifest_json FROM versions WHERE id = ?')
          .get(request.params.versionId) as
          | { plugin_id: string; state: string; manifest_json: string }
          | undefined
        if (!version) throw new HttpError(404, '版本不存在')
        if (version.state !== 'pending') throw new HttpError(409, '该版本已审核')
        db.prepare('UPDATE versions SET state = ?, note = ?, reviewed_at = ? WHERE id = ?').run(
          body.decision,
          note,
          now(),
          request.params.versionId,
        )
        if (body.decision === 'approved') {
          const manifest = JSON.parse(version.manifest_json) as PluginManifest
          const live = liveVersion(db, version.plugin_id)
          if (live && !newerVersion(manifest.version, live.version)) return
          db.prepare(
            'UPDATE plugins SET live_version_id = ?, name = ?, summary = ? WHERE id = ?',
          ).run(request.params.versionId, manifest.name, manifest.summary, version.plugin_id)
          const pending = db
            .prepare("SELECT id, version FROM versions WHERE plugin_id = ? AND state = 'pending'")
            .all(version.plugin_id) as { id: string; version: string }[]
          const reject = db.prepare(
            "UPDATE versions SET state = 'rejected', note = '已有更新版本', reviewed_at = ? WHERE id = ?",
          )
          for (const older of pending) {
            if (newerVersion(manifest.version, older.version)) reject.run(now(), older.id)
          }
        }
      })()
      return { ok: true }
    },
  )
}

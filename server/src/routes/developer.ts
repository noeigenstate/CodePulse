import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { OFFICIAL_PLUGIN_PREFIX, type PluginManifest } from '@codepulse/shared'
import { checkPassword, hashPassword, randomToken, tokenHash } from '../auth.js'
import type { Context } from '../context.js'
import type { Developer, Version } from '../db.js'
import { generationError } from '../generate/index.js'
import { checkedEndpoint, deadline } from '../generate/webhook.js'
import {
  HttpError,
  invalid,
  newerVersion,
  object,
  pluginId,
  text,
  validateCards,
  validateManifest,
} from '../validation.js'

interface OwnedPlugin {
  id: string
  name: string
  summary: string
  webhook_secret: string
  liveVersion: string | null
}

function ownPlugin(context: Context, developerId: string, id: string): OwnedPlugin {
  const plugin = context.db
    .prepare(
      `SELECT p.*, v.version AS liveVersion FROM plugins p
    LEFT JOIN versions v ON p.live_version_id = v.id WHERE p.id = ? AND p.developer_id = ?`,
    )
    .get(id, developerId) as OwnedPlugin | undefined
  if (!plugin) throw new HttpError(404, '插件不存在或无权访问')
  return plugin
}

function credentials(value: unknown): {
  email: string
  password: string
  body: Record<string, unknown>
} {
  const body = object(value)
  const email = text(body.email, 254, '邮箱').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) invalid('邮箱格式无效')
  const password = text(body.password, 128, '密码')
  return { email, password, body }
}

async function submission(
  context: Context,
  value: unknown,
  id: string,
): Promise<{
  manifest: PluginManifest
  payload: Record<string, unknown>
  settings: unknown
}> {
  const body = object(value)
  const manifest = validateManifest(body.manifest, id)
  if (body.settings !== undefined) object(body.settings)
  if (manifest.kind === 'pack') {
    const cards = validateCards(body.cards, context.now(), context.now() + 86400000, 60).map(
      ({ expiresAt: _expiry, ...card }) => card,
    )
    return { manifest, payload: { cards }, settings: body.settings }
  }
  const endpoint = text(body.endpoint, 2048, '接口地址')
  try {
    await deadline(() =>
      checkedEndpoint(endpoint, context.resolveHost, context.allowHttpLoopbackWebhooks),
    )
  } catch (error) {
    throw new HttpError(422, generationError(error))
  }
  return { manifest, payload: { endpoint }, settings: body.settings }
}

export function developerRoutes(app: FastifyInstance, context: Context): void {
  const { db, auth, rate, now } = context
  app.post('/api/v1/dev/register', async (request) => {
    rate.check(`register:${request.ip}`, 10)
    const { email, password, body } = credentials(request.body)
    if (password.length < 8) invalid('密码至少8位')
    const name = text(body.name, 32, '开发者名称')
    if (db.prepare('SELECT id FROM developers WHERE email = ?').get(email))
      throw new HttpError(409, '邮箱已注册')
    const developer: Developer = {
      id: randomUUID(),
      email,
      name,
      password_hash: await hashPassword(password),
      admin: 0,
    }
    // Hashing yields to other registrations, so the unique constraint must also guard this insert.
    try {
      db.prepare(
        'INSERT INTO developers (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(developer.id, email, name, developer.password_hash, now())
    } catch (error) {
      if ((error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE')
        throw new HttpError(409, '邮箱已注册')
      throw error
    }
    return {
      token: auth.session('developer', developer.id).token,
      developer: auth.publicDeveloper(developer),
    }
  })

  app.post('/api/v1/dev/login', async (request) => {
    rate.check(`login:${request.ip}`, 10)
    const { email, password } = credentials(request.body)
    const developer = db.prepare('SELECT * FROM developers WHERE email = ?').get(email) as
      | Developer
      | undefined
    if (!(await checkPassword(password, developer?.password_hash ?? null)) || !developer)
      throw new HttpError(401, '邮箱或密码不正确')
    return {
      token: auth.session('developer', developer.id).token,
      developer: auth.publicDeveloper(developer),
    }
  })

  app.get('/api/v1/dev/me', async (request) => ({
    developer: auth.publicDeveloper(auth.developer(request)),
  }))
  app.post('/api/v1/dev/logout', async (request) => {
    auth.developer(request)
    db.prepare("DELETE FROM sessions WHERE token_hash = ? AND kind = 'developer'").run(
      tokenHash(auth.bearer(request)),
    )
    return { ok: true }
  })

  app.get('/api/v1/dev/plugins', async (request) => {
    const developer = auth.developer(request)
    const plugins = db
      .prepare(
        `SELECT p.id, p.name, p.summary, v.version AS liveVersion
      FROM plugins p LEFT JOIN versions v ON v.id = p.live_version_id
      WHERE p.developer_id = ? ORDER BY p.created_at, p.id`,
      )
      .all(developer.id) as OwnedPlugin[]
    return {
      plugins: plugins.map((plugin) => ({
        ...plugin,
        versions: (
          db
            .prepare(
              'SELECT * FROM versions WHERE plugin_id = ? ORDER BY submitted_at DESC, rowid DESC',
            )
            .all(plugin.id) as Version[]
        ).map((v) => ({
          id: v.id,
          version: v.version,
          kind: (JSON.parse(v.manifest_json) as PluginManifest).kind,
          state: v.state,
          note: v.note,
          submittedAt: v.submitted_at,
        })),
      })),
    }
  })

  app.post('/api/v1/dev/plugins', async (request) => {
    const developer = auth.developer(request)
    rate.check(`dev-create:${developer.id}`, 10, 3600000)
    const body = object(request.body)
    const id = pluginId(body.id)
    if (id.startsWith(OFFICIAL_PLUGIN_PREFIX)) throw new HttpError(403, '这个前缀保留给官方插件')
    const plugin = {
      id,
      name: text(body.name, 24, '插件名称'),
      summary: text(body.summary, 60, '插件简介'),
    }
    if (db.prepare('SELECT id FROM plugins WHERE id = ?').get(plugin.id))
      throw new HttpError(409, '插件标识已存在')
    const webhookSecret = randomToken()
    db.prepare(
      `INSERT INTO plugins (id, developer_id, name, summary, webhook_secret, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(plugin.id, developer.id, plugin.name, plugin.summary, webhookSecret, now())
    return { plugin, webhookSecret }
  })

  app.post<{ Params: { id: string } }>('/api/v1/dev/plugins/:id/versions', async (request) => {
    const developer = auth.developer(request)
    rate.check(`dev-version:${developer.id}`, 10, 3600000)
    ownPlugin(context, developer.id, request.params.id)
    const { manifest, payload } = await submission(context, request.body, request.params.id)
    const version = { id: randomUUID(), version: manifest.version, state: 'pending' as const }
    db.transaction(() => {
      const latest = db
        .prepare('SELECT version FROM versions WHERE plugin_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(manifest.id) as { version: string } | undefined
      if (latest && !newerVersion(manifest.version, latest.version))
        throw new HttpError(409, '新版本须高于最近提交版本')
      db.prepare(
        `INSERT INTO versions (id, plugin_id, version, manifest_json, payload_json, state, submitted_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      ).run(
        version.id,
        manifest.id,
        manifest.version,
        JSON.stringify(manifest),
        JSON.stringify(payload),
        now(),
      )
    })()
    return { version }
  })

  app.post<{ Params: { id: string } }>('/api/v1/dev/plugins/:id/test', async (request) => {
    const developer = auth.developer(request)
    rate.check(`dev-test:${developer.id}`, 6)
    const plugin = ownPlugin(context, developer.id, request.params.id)
    const { manifest, payload, settings } = await submission(context, request.body, plugin.id)
    const version: Version = {
      id: 'test',
      plugin_id: plugin.id,
      version: manifest.version,
      manifest_json: JSON.stringify(manifest),
      payload_json: JSON.stringify(payload),
      state: 'draft',
      note: '',
      submitted_at: now(),
      reviewed_at: null,
      webhook_secret: plugin.webhook_secret,
    }
    try {
      return {
        cards: await context.generator.generate(version, settings),
        error: '',
      }
    } catch (error) {
      return { cards: [], error: generationError(error) }
    }
  })
}

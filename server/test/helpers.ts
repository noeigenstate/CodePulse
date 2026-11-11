import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance, InjectOptions } from 'fastify'
import type { PluginSetting } from '@codepulse/shared'
import { buildApp, type AppOptions } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { promoteAdmin } from '../src/admin.js'

const temporary = resolve(dirname(fileURLToPath(import.meta.url)), '../server-fixtures')
mkdirSync(temporary, { recursive: true })
const databases = new WeakMap<FastifyInstance, string>()

export const INITIAL = Date.parse('2026-11-08T04:00:00Z')
export const card = { id: 'one', source: '测试卡片', text: '第一张卡片' }
export const pack = {
  id: 'demo.pack',
  version: '1.0.0',
  name: '测试插件',
  summary: '简短介绍',
  description: '说明',
  kind: 'pack',
  refreshMinutes: 15,
  settings: [
    { key: 'count', label: '数量', type: 'number', min: 1, max: 4, default: 2 },
    { key: 'city', label: '城市', type: 'text', maxLength: 4, default: '北京' },
    { key: 'on', label: '开关', type: 'boolean', default: true },
    {
      key: 'mode',
      label: '模式',
      type: 'select',
      default: 'a',
      options: [
        { value: 'a', label: '甲' },
        { value: 'b', label: '乙' },
      ],
    },
  ] satisfies PluginSetting[],
}

export const hnFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      hits: [
        {
          title: '一个技术故事',
          points: 200,
          num_comments: 12,
          url: 'https://www.example.com/story',
          created_at_i: INITIAL / 1000 - 10800,
        },
        {
          title: '另一个故事',
          points: 120,
          num_comments: 8,
          url: null,
          created_at_i: INITIAL / 1000 - 3600,
        },
        {
          title: '低热度故事',
          points: 20,
          num_comments: 2,
          url: 'https://example.org',
          created_at_i: INITIAL / 1000,
        },
      ],
    }),
  )

export function fixture(t: TestContext, options: AppOptions = {}) {
  let time = INITIAL
  const directory = mkdtempSync(resolve(temporary, 'fixture-'))
  const dbPath = options.dbPath ?? resolve(directory, 'platform.sqlite')
  const app = buildApp({
    dbPath,
    now: () => time,
    fetch: hnFetch,
    resolveHost: async () => ['93.184.216.34'],
    webhookTransport: async () => ({ status: 200, body: JSON.stringify({ cards: [card] }) }),
    ...options,
  })
  databases.set(app, dbPath)
  t.after(async () => {
    await app.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return {
    app,
    dbPath,
    setTime: (next: number) => {
      time = next
    },
    advance: (ms: number) => {
      time += ms
    },
  }
}

export async function call(
  app: FastifyInstance,
  method: InjectOptions['method'],
  url: string,
  payload?: unknown,
  token?: string,
) {
  const response = await app.inject({
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as object }),
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: response.statusCode, body: response.json() }
}

export async function developer(app: FastifyInstance, email = 'dev@example.com') {
  const response = await call(app, 'POST', '/api/v1/dev/register', {
    email,
    password: 'password123',
    name: '测试开发者',
  })
  assert.equal(response.status, 200)
  assert.equal(response.body.developer.admin, false)
  return response.body.token as string
}

export async function store(app: FastifyInstance) {
  const client = await call(app, 'POST', '/api/v1/clients')
  assert.equal(client.status, 200)
  const code = await call(app, 'POST', '/api/v1/clients/store-code', {}, client.body.token)
  assert.equal(code.status, 200)
  assert.equal(code.body.expiresAt, INITIAL + 60000)
  const session = await call(app, 'POST', '/api/v1/store/session', { code: code.body.code })
  assert.equal(session.status, 200)
  return {
    client: client.body.token as string,
    token: session.body.token as string,
    code: code.body.code as string,
  }
}

export async function upload(
  app: FastifyInstance,
  token: string,
  manifest = pack,
  payload: object = { cards: [card] },
) {
  const created = await call(
    app,
    'POST',
    '/api/v1/dev/plugins',
    { id: manifest.id, name: manifest.name, summary: manifest.summary },
    token,
  )
  assert.equal(created.status, 200)
  const submitted = await call(
    app,
    'POST',
    `/api/v1/dev/plugins/${manifest.id}/versions`,
    { manifest, ...payload },
    token,
  )
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body))
  return {
    versionId: submitted.body.version.id as string,
    secret: created.body.webhookSecret as string,
  }
}

export async function approve(app: FastifyInstance, versionId: string, admin?: string) {
  const token = admin ?? (await administrator(app))
  assert.equal(
    (await call(app, 'POST', `/api/v1/admin/reviews/${versionId}`, { decision: 'approved' }, token))
      .status,
    200,
  )
  return token
}

export async function livePack(
  app: FastifyInstance,
  manifest = pack,
  payload: object = { cards: [card] },
) {
  const dev = await developer(app)
  const uploaded = await upload(app, dev, manifest, payload)
  const admin = await approve(app, uploaded.versionId)
  return { dev, admin, ...uploaded }
}

export async function administrator(app: FastifyInstance) {
  const token = await developer(app, 'admin@example.com')
  const db = openDatabase(databases.get(app)!)
  try {
    promoteAdmin(db, 'admin@example.com')
  } finally {
    db.close()
  }
  return token
}

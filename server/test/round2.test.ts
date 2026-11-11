import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase } from '../src/db.js'
import { call, developer, fixture, INITIAL, livePack, pack, store } from './helpers.js'
import { png } from './logo-images.js'

const installs = '/api/v1/client/installs'

test('客户端与商店共用安装数据：列表、设置、开关、状态、隔离及卸载', async (t) => {
  const { app } = fixture(t)
  const { dev } = await livePack(app)
  const a = await store(app)
  const b = await store(app)
  assert.deepEqual((await call(app, 'GET', installs, undefined, a.client)).body, { installs: [] })
  assert.equal((await call(app, 'PUT', `/api/v1/installs/${pack.id}`, {}, a.token)).status, 200)
  const installed = await call(
    app,
    'PUT',
    `${installs}/${pack.id}`,
    { settings: { city: '上海' } },
    a.client,
  )
  assert.equal(installed.status, 200)
  assert.deepEqual(installed.body.install, {
    pluginId: pack.id,
    enabled: true,
    settings: { count: 2, city: '上海', on: true, mode: 'a' },
    installedAt: INITIAL,
  })
  const before = (await call(app, 'GET', installs, undefined, a.client)).body.installs[0]
  assert.deepEqual(before.status, { generatedAt: null, error: '' })
  assert.equal(before.plugin.id, pack.id)
  assert.equal(before.plugin.logoUrl, null)
  const logo = await call(
    app,
    'PUT',
    `/api/v1/dev/plugins/${pack.id}/logo`,
    { type: 'image/png', data: png().toString('base64') },
    dev,
  )
  await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)
  const after = (await call(app, 'GET', installs, undefined, a.client)).body.installs[0]
  assert.equal(after.plugin.logoUrl, logo.body.logoUrl)
  assert.deepEqual(after.status, { generatedAt: INITIAL, error: '' })
  assert.deepEqual(
    (await call(app, 'GET', '/api/v1/installs', undefined, a.token)).body.installs[0],
    after,
  )
  assert.deepEqual((await call(app, 'GET', installs, undefined, b.client)).body.installs, [])
  const disabled = await call(app, 'PUT', `${installs}/${pack.id}`, { enabled: false }, a.client)
  assert.equal(disabled.body.install.enabled, false)
  assert.equal(disabled.body.install.settings.city, '上海')
  assert.equal(disabled.body.install.installedAt, INITIAL)
  assert.deepEqual(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)).body.cards,
    [],
  )
  await call(app, 'PUT', `/api/v1/installs/${pack.id}`, { enabled: true }, a.token)
  assert.equal(
    (await call(app, 'GET', installs, undefined, a.client)).body.installs[0].enabled,
    true,
  )
  assert.equal(
    (await call(app, 'PUT', `${installs}/${pack.id}`, { enabled: 'yes' }, a.client)).status,
    422,
  )
  assert.equal(
    (await call(app, 'PUT', `${installs}/${pack.id}`, { settings: [] }, a.client)).status,
    422,
  )
  assert.equal((await call(app, 'PUT', `${installs}/missing`, {}, a.client)).status, 404)
  assert.deepEqual(
    (await call(app, 'DELETE', `${installs}/${pack.id}`, undefined, a.client)).body,
    { ok: true },
  )
  assert.deepEqual(
    (await call(app, 'GET', '/api/v1/installs', undefined, a.token)).body.installs,
    [],
  )
  assert.deepEqual(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)).body.cards,
    [],
  )
})

test('客户端 PUT 不创建或恢复安装，商店 PUT 仍可安装', async (t) => {
  const { app } = fixture(t)
  const a = await store(app)
  const b = await store(app)
  const id = 'codepulse.daily-poem'
  const update = (token: string) => call(app, 'PUT', `${installs}/${id}`, { enabled: true }, token)
  const missing = await update(a.client)
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.body, { error: '插件未安装' })
  assert.equal((await call(app, 'PUT', `/api/v1/installs/${id}`, {}, a.token)).status, 200)
  assert.equal((await update(a.client)).status, 200)
  assert.equal((await update(b.client)).status, 404)
  assert.equal((await call(app, 'DELETE', `${installs}/${id}`, undefined, a.client)).status, 200)
  const stale = await update(a.client)
  assert.equal(stale.status, 404)
  assert.deepEqual(stale.body, { error: '插件未安装' })
  assert.deepEqual((await call(app, 'GET', installs, undefined, a.client)).body.installs, [])
  assert.equal((await call(app, 'PUT', `/api/v1/installs/${id}`, {}, a.token)).status, 200)
  assert.equal((await call(app, 'GET', installs, undefined, a.client)).body.installs.length, 1)
})

test('客户端安装列表在插件撤回后返回 plugin:null 和不可用原因，仍可卸载', async (t) => {
  const { app, dbPath } = fixture(t)
  const { versionId } = await livePack(app)
  const a = await store(app)
  await call(app, 'PUT', `/api/v1/installs/${pack.id}`, {}, a.token)
  const db = openDatabase(dbPath)
  try {
    db.prepare("UPDATE versions SET state = 'rejected' WHERE id = ?").run(versionId)
  } finally {
    db.close()
  }
  const item = (await call(app, 'GET', installs, undefined, a.client)).body.installs[0]
  assert.equal(item.plugin, null)
  assert.deepEqual(item.status, { generatedAt: null, error: '插件暂不可用' })
  assert.equal(
    (await call(app, 'DELETE', `${installs}/${pack.id}`, undefined, a.client)).status,
    200,
  )
})

test('客户端安装接口的 GET/PUT/DELETE 拒绝缺失、无效及其他种类凭据', async (t) => {
  const { app } = fixture(t)
  const a = await store(app)
  const dev = await developer(app)
  for (const method of ['GET', 'PUT', 'DELETE'] as const) {
    const url = method === 'GET' ? installs : `${installs}/codepulse.daily-poem`
    for (const token of [undefined, 'invalid', 'a'.repeat(43), a.token, dev]) {
      assert.equal(
        (await call(app, method, url, method === 'PUT' ? {} : undefined, token)).status,
        401,
      )
    }
  }
})

test('安装接口所有方法和两种凭据按客户端共用 30/min，不影响其他客户端', async (t) => {
  const { app, advance } = fixture(t)
  const a = await store(app)
  const b = await store(app)
  for (let i = 0; i < 30; i++) {
    const path = i % 2 ? '/api/v1/installs' : installs
    const token = i % 2 ? a.token : a.client
    const method = (['GET', 'PUT', 'PUT', 'DELETE'] as const)[i % 4]
    const url = method === 'GET' ? path : `${path}/codepulse.daily-poem`
    assert.equal(
      (await call(app, method, url, method === 'PUT' ? {} : undefined, token)).status,
      200,
    )
  }
  for (const [path, token] of [
    [installs, a.client],
    ['/api/v1/installs', a.token],
  ]) {
    assert.equal((await call(app, 'GET', path, undefined, token)).status, 429)
  }
  assert.equal((await call(app, 'GET', installs, undefined, b.client)).status, 200)
  advance(60000)
  assert.equal((await call(app, 'GET', installs, undefined, a.client)).status, 200)
})

test('商店网页、静态资源、SPA 回退和非 API 错误均有 CSP/nosniff，API 保持 no-store', async (t) => {
  const webDir = mkdtempSync(resolve(dirname(fileURLToPath(import.meta.url)), 'web-'))
  t.after(() => rmSync(webDir, { recursive: true, force: true }))
  mkdirSync(resolve(webDir, 'assets'))
  writeFileSync(resolve(webDir, 'index.html'), '<!doctype html><title>插件</title>')
  writeFileSync(resolve(webDir, 'assets/main.js'), 'document.title = "插件"')
  const { app } = fixture(t, { webDir })
  const expected =
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'"
  for (const url of ['/', '/assets/main.js', '/developer', '/?embed=desktop']) {
    const response = await app.inject({ url })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-security-policy'], expected)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
    assert.equal(response.headers['x-frame-options'], undefined)
  }
  const error = await app.inject({ method: 'POST', url: '/missing' })
  assert.equal(error.statusCode, 404)
  assert.equal(error.headers['content-security-policy'], expected)
  for (const url of [
    '/api/v1/plugins',
    '/api/missing',
    '/api',
    '/api?missing=1',
    '/api/v1/plugins/missing/logo',
  ]) {
    const response = await app.inject({ url })
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.headers['content-security-policy'], undefined)
    assert.equal(response.headers['x-content-type-options'], 'nosniff')
  }
})

test('v2 升级 v3 保留开发者、客户端、版本、安装、令牌和缓存；重开幂等', async (t) => {
  const { app, dbPath } = fixture(t)
  const { dev } = await livePack(app)
  const a = await store(app)
  await call(app, 'PUT', `/api/v1/installs/${pack.id}`, {}, a.token)
  await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)
  const old = openDatabase(dbPath)
  const tables = [
    'developers',
    'clients',
    'sessions',
    'plugins',
    'versions',
    'installs',
    'card_cache',
  ]
  const previous = tables.map((table) => old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
  old.exec('DROP TABLE logos; PRAGMA user_version = 2;')
  old.close()
  const db = openDatabase(dbPath)
  try {
    assert.equal(db.pragma('user_version', { simple: true }), 3)
    for (const [i, table] of tables.entries()) {
      assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), previous[i])
    }
    assert.deepEqual(db.prepare('SELECT * FROM logos').all(), [])
    assert.throws(
      () =>
        db
          .prepare('INSERT INTO logos VALUES (?, ?, ?, ?, ?)')
          .run('missing', 'image/png', png(), 'hash', INITIAL),
      /FOREIGN KEY/,
    )
  } finally {
    db.close()
  }
  assert.equal((await call(app, 'GET', '/api/v1/dev/me', undefined, dev)).status, 200)
  assert.equal((await call(app, 'GET', installs, undefined, a.client)).body.installs.length, 1)
  const reopened = openDatabase(dbPath)
  assert.equal(reopened.pragma('user_version', { simple: true }), 3)
  reopened.close()
})

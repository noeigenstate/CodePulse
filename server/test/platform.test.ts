import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHmac } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeDeviceLife, normalizePluginCard } from '@codepulse/shared'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { Auth, tokenHash } from '../src/auth.js'
import {
  checkedEndpoint,
  isPublicAddress,
  type WebhookRequest,
  type WebhookTransport,
} from '../src/generate/webhook.js'
import { localDay, packCard } from '../src/generate/pack.js'

import {
  INITIAL,
  card,
  pack,
  hnFetch,
  fixture,
  call,
  developer,
  store,
  upload,
  approve,
  livePack,
  administrator,
} from './helpers.js'

test('注册、登录、个人信息和退出；错误密码为401', async (t) => {
  const { app } = fixture(t)
  const token = await developer(app, 'Dev@Example.com')
  const me = await call(app, 'GET', '/api/v1/dev/me', undefined, token)
  assert.deepEqual(me.body.developer, {
    email: 'dev@example.com',
    name: '测试开发者',
    admin: false,
  })
  assert.equal(
    (await call(app, 'POST', '/api/v1/dev/login', { email: 'dev@example.com', password: 'wrong' }))
      .status,
    401,
  )
  assert.equal(
    (
      await call(app, 'POST', '/api/v1/dev/login', {
        email: 'missing@example.com',
        password: 'wrong',
      })
    ).status,
    401,
  )
  assert.equal(
    (
      await call(app, 'POST', '/api/v1/dev/login', {
        email: 'dev@example.com',
        password: 'password123',
      })
    ).status,
    200,
  )
  assert.equal(
    (
      await call(app, 'POST', '/api/v1/dev/register', {
        email: 'dev@example.com',
        password: 'password123',
        name: '重复',
      })
    ).status,
    409,
  )
  assert.equal((await call(app, 'POST', '/api/v1/dev/logout', {}, token)).status, 200)
  assert.equal((await call(app, 'GET', '/api/v1/dev/me', undefined, token)).status, 401)
})

test('会话类型隔离，商店码一次性且60秒过期，商店会话12小时过期', async (t) => {
  const { app, setTime } = fixture(t)
  const session = await store(app)
  assert.equal(
    (await call(app, 'POST', '/api/v1/store/session', { code: session.code })).status,
    401,
  )
  assert.equal((await call(app, 'GET', '/api/v1/installs', undefined, session.client)).status, 401)
  assert.equal(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, session.token)).status,
    401,
  )
  const code = await call(app, 'POST', '/api/v1/clients/store-code', {}, session.client)
  setTime(INITIAL + 60000)
  assert.equal(
    (await call(app, 'POST', '/api/v1/store/session', { code: code.body.code })).status,
    401,
  )
  setTime(INITIAL + 12 * 3600000)
  assert.equal((await call(app, 'GET', '/api/v1/installs', undefined, session.token)).status, 401)
})

test('数据库只保存令牌哈希，开发者会话7天过期', async () => {
  const db = openDatabase(':memory:')
  try {
    let time = INITIAL
    const auth = new Auth(db, () => time)
    const session = auth.session('developer', 'dev')
    const row = db.prepare('SELECT * FROM sessions').get() as {
      token_hash: string
      expires_at: number
    }
    assert.equal(row.token_hash, tokenHash(session.token))
    assert.equal(row.expires_at, INITIAL + 7 * 86400000)
    time = row.expires_at
    assert.throws(
      () =>
        auth.subject(
          { headers: { authorization: `Bearer ${session.token}` } } as never,
          'developer',
        ),
      /登录已失效/,
    )
    assert.equal(db.pragma('user_version', { simple: true }), 2)
  } finally {
    db.close()
  }
})

test('官方种子公开且不可登录，支持目录筛选和单个插件', async (t) => {
  const { app } = fixture(t)
  const list = await call(app, 'GET', '/api/v1/plugins')
  assert.equal(list.body.plugins.length, 2)
  assert.ok(list.body.plugins.every((p: { developer: string }) => p.developer === 'CodePulse 官方'))
  assert.equal((await call(app, 'GET', '/api/v1/plugins?kind=pack&q=古诗')).body.plugins.length, 1)
  assert.equal((await call(app, 'GET', '/api/v1/plugins/codepulse.daily-poem')).status, 200)
  assert.equal((await call(app, 'GET', '/api/v1/plugins/missing')).status, 404)
  assert.equal(
    (
      await call(app, 'POST', '/api/v1/dev/login', {
        email: 'official@codepulse.invalid',
        password: 'password123',
      })
    ).status,
    401,
  )
})

test('未审核版本不可见，审核通过公开；拒绝后版本仍不可见', async (t) => {
  const { app } = fixture(t)
  const token = await developer(app)
  const uploaded = await upload(app, token)
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).status, 404)
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)).status, 404)
  const admin = await administrator(app)
  const reviews = await call(app, 'GET', '/api/v1/admin/reviews', undefined, admin)
  assert.equal(reviews.body.reviews[0].cardCount, 1)
  assert.equal(reviews.body.reviews[0].endpoint, null)
  await approve(app, uploaded.versionId, admin)
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin.version, '1.0.0')
  const v2 = await call(
    app,
    'POST',
    `/api/v1/dev/plugins/${pack.id}/versions`,
    { manifest: { ...pack, version: '1.1.0' }, cards: [card] },
    token,
  )
  assert.equal(v2.status, 200)
  assert.equal(
    (
      await call(
        app,
        'POST',
        `/api/v1/admin/reviews/${v2.body.version.id}`,
        { decision: 'rejected', note: '内容需调整' },
        admin,
      )
    ).status,
    200,
  )
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin.version, '1.0.0')
  const mine = await call(app, 'GET', '/api/v1/dev/plugins', undefined, token)
  assert.equal(mine.body.plugins[0].liveVersion, '1.0.0')
  assert.equal(mine.body.plugins[0].versions[0].note, '内容需调整')
  assert.equal(
    (
      await call(
        app,
        'POST',
        `/api/v1/admin/reviews/${uploaded.versionId}`,
        { decision: 'approved' },
        admin,
      )
    ).status,
    409,
  )
})

test('普通开发者不能审核或修改他人插件，不能提交builtin', async (t) => {
  const { app } = fixture(t)
  const token = await developer(app)
  const other = await developer(app, 'other@example.com')
  const { versionId } = await upload(app, token)
  assert.equal((await call(app, 'GET', '/api/v1/admin/reviews', undefined, token)).status, 403)
  assert.equal(
    (await call(app, 'POST', `/api/v1/admin/reviews/${versionId}`, { decision: 'approved' }, token))
      .status,
    403,
  )
  assert.equal(
    (
      await call(
        app,
        'POST',
        `/api/v1/dev/plugins/${pack.id}/versions`,
        { manifest: { ...pack, version: '1.1.0' }, cards: [card] },
        other,
      )
    ).status,
    404,
  )
  assert.equal(
    (
      await call(
        app,
        'POST',
        `/api/v1/dev/plugins/${pack.id}/versions`,
        { manifest: { ...pack, kind: 'builtin' } },
        token,
      )
    ).status,
    422,
  )
})

test('安装、修改、默认设置归一化、状态及卸载；客户端相互隔离', async (t) => {
  const { app } = fixture(t)
  await livePack(app)
  const a = await store(app)
  const b = await store(app)
  const installed = await call(
    app,
    'PUT',
    `/api/v1/installs/${pack.id}`,
    { settings: { count: 100, city: '上海', on: 'yes', mode: 'b', unknown: true } },
    a.token,
  )
  assert.equal(installed.status, 200)
  assert.deepEqual(installed.body.install.settings, { count: 2, city: '上海', on: true, mode: 'b' })
  assert.equal(installed.body.install.enabled, true)
  assert.equal(
    (await call(app, 'GET', '/api/v1/installs', undefined, b.token)).body.installs.length,
    0,
  )
  assert.equal((await call(app, 'GET', '/api/v1/plugins/demo.pack')).body.plugin.installs, 1)
  await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)
  const status = await call(app, 'GET', '/api/v1/installs', undefined, a.token)
  assert.equal(status.body.installs[0].status.generatedAt, INITIAL)
  assert.equal(status.body.installs[0].status.error, '')
  assert.equal(
    (await call(app, 'PUT', `/api/v1/installs/${pack.id}`, { enabled: false }, a.token)).body
      .install.settings.city,
    '上海',
  )
  assert.equal((await call(app, 'PUT', '/api/v1/installs/missing', {}, a.token)).status, 404)
  assert.equal(
    (await call(app, 'PUT', `/api/v1/installs/${pack.id}`, { enabled: 'yes' }, a.token)).status,
    422,
  )
  assert.equal(
    (await call(app, 'DELETE', `/api/v1/installs/${pack.id}`, undefined, a.token)).status,
    200,
  )
  assert.equal(
    (await call(app, 'GET', '/api/v1/installs', undefined, a.token)).body.installs.length,
    0,
  )
})

test('卡片流只包含已启用安装；卸载立即消失', async (t) => {
  const { app, advance } = fixture(t)
  const session = await store(app)
  await call(app, 'PUT', '/api/v1/installs/codepulse.daily-poem', {}, session.token)
  await call(app, 'PUT', '/api/v1/installs/codepulse.hn-digest', { enabled: false }, session.token)
  const feed = await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)
  assert.equal(feed.status, 200)
  assert.equal(feed.body.v, 1)
  assert.equal(feed.body.cards.length, 1)
  assert.equal(feed.body.cards[0].pluginId, 'codepulse.daily-poem')
  assert.ok(normalizePluginCard(feed.body.cards[0], INITIAL))
  await call(app, 'DELETE', '/api/v1/installs/codepulse.daily-poem', undefined, session.token)
  advance(60000)
  assert.deepEqual(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)).body.cards,
    [],
  )
})

test('内容包按平台时区日期轮换，跨午夜提前更新缓存', async (t) => {
  const cards = [card, { ...card, id: 'two', text: '第二张卡片' }]
  const { app, setTime } = fixture(t)
  await livePack(app, { ...pack, refreshMinutes: 1440 }, { cards })
  const before = Date.parse('2026-11-08T15:59:00Z')
  const after = Date.parse('2026-11-08T16:01:00Z')
  setTime(before)
  const first = await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
  assert.equal(first.body.cards[0].expiresAt, localDay(before).end)
  setTime(after)
  const second = await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
  assert.notEqual(first.body.cards[0].id, second.body.cards[0].id)
  assert.equal(packCard(cards, before)[0].id, cards[localDay(before).index % 2].id)
})

test('HN版式通过共享校验，筛选数量、热度、站点与年龄正确', async (t) => {
  const { app, advance } = fixture(t)
  const session = await store(app)
  await call(
    app,
    'PUT',
    '/api/v1/installs/codepulse.hn-digest',
    { settings: { count: '2', minPoints: 100 } },
    session.token,
  )
  const feed = await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)
  const hn = feed.body.cards[0]
  assert.ok(normalizeDeviceLife(hn.life))
  assert.equal(hn.life.stories.length, 2)
  assert.equal(hn.life.stories[0].site, 'example.com')
  assert.equal(hn.life.stories[0].age, '3小时')
  assert.match(hn.text, /一个技术故事/)
  advance(16 * 60000)
  const refreshed = await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)
  assert.equal(refreshed.body.cards[0].id, hn.id)
  assert.equal(hn.life.updated, '12:00')
  assert.equal(refreshed.body.cards[0].life.updated, '12:16')
})

test('webhook传输固定已校验地址，HMAC与请求契约正确，补齐有效期', async (t) => {
  let captured: WebhookRequest | undefined
  const { app } = fixture(t, {
    webhookTransport: async (request) => {
      captured = request
      return { status: 200, body: JSON.stringify({ cards: [card] }) }
    },
  })
  const manifest = { ...pack, id: 'demo.webhook', kind: 'webhook' }
  const { secret } = await livePack(app, manifest, { endpoint: 'https://example.com/generate' })
  const preview = await call(app, 'GET', '/api/v1/plugins/demo.webhook/preview')
  assert.equal(preview.body.error, '')
  assert.equal(preview.body.cards[0].expiresAt, INITIAL + 30 * 60000)
  assert.ok(captured)
  assert.equal(captured.address, '93.184.216.34')
  assert.equal(captured.url.hostname, 'example.com')
  assert.deepEqual(JSON.parse(captured.body), {
    v: 1,
    pluginId: manifest.id,
    version: '1.0.0',
    settings: { count: 2, city: '北京', on: true, mode: 'a' },
    locale: 'zh-CN',
    now: INITIAL,
  })
  assert.equal(
    captured.headers['X-CodePulse-Signature'],
    'sha256=' +
      createHmac('sha256', secret)
        .update(`${captured.headers['X-CodePulse-Timestamp']}.${captured.body}`)
        .digest('hex'),
  )
})

test('webhook提交和生成均检查DNS，重绑定到内网不触发传输', async (t) => {
  let privateDns = false
  let calls = 0
  const { app } = fixture(t, {
    resolveHost: async () => (privateDns ? ['10.0.0.1'] : ['93.184.216.34']),
    webhookTransport: async () => {
      calls++
      return { status: 200, body: JSON.stringify({ cards: [card] }) }
    },
  })
  const { dev } = await livePack(
    app,
    { ...pack, kind: 'webhook' },
    { endpoint: 'https://example.com' },
  )
  privateDns = true
  const preview = await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
  assert.match(preview.body.error, /内网/)
  assert.equal(calls, 0)
  const bad = await call(
    app,
    'POST',
    `/api/v1/dev/plugins/${pack.id}/versions`,
    {
      manifest: { ...pack, kind: 'webhook', version: '1.1.0' },
      endpoint: 'https://example.com',
    },
    dev,
  )
  assert.equal(bad.status, 422)
})

test('拒绝IPv4/IPv6内网、映射、保留和混合DNS；仅显式允许本地HTTP', async () => {
  const rejected = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.168.1.1',
    '192.0.0.9',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2001:db8::1',
    '2002:7f00:1::',
    '2001::1',
  ]
  for (const ip of rejected) {
    assert.equal(isPublicAddress(ip), false, ip)
    await assert.rejects(
      checkedEndpoint('https://example.com', async () => [ip], false),
      /内网/,
    )
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
    assert.equal(isPublicAddress(ip), true, ip)
  await assert.rejects(
    checkedEndpoint('https://example.com', async () => ['8.8.8.8', '::1'], false),
    /内网/,
  )
  await assert.rejects(
    checkedEndpoint('http://127.0.0.1', async () => [], false),
    /HTTPS/,
  )
  await assert.rejects(
    checkedEndpoint('http://192.168.1.1', async () => [], true),
    /HTTPS/,
  )
  await assert.rejects(
    checkedEndpoint('https://user:pass@example.com', async () => ['8.8.8.8'], false),
    /HTTPS/,
  )
  assert.equal(
    (await checkedEndpoint('http://localhost', async () => ['127.0.0.1', '::1'], true)).address,
    '127.0.0.1',
  )
})

for (const [name, transport, pattern] of [
  ['重定向', async () => ({ status: 302, body: '' }), /重定向/],
  ['超大响应', async () => ({ status: 200, body: '中'.repeat(23000) }), /64 KiB/],
  ['无效JSON', async () => ({ status: 200, body: '{bad' }), /JSON/],
  [
    '坏卡片',
    async () => ({ status: 200, body: JSON.stringify({ cards: [{ ...card, imageHex: 'bad' }] }) }),
    /卡片/,
  ],
  [
    '卡片过多',
    async () => ({
      status: 200,
      body: JSON.stringify({
        cards: Array.from({ length: 13 }, (_, i) => ({ ...card, id: String(i) })),
      }),
    }),
    /数量/,
  ],
  ['超时', async () => new Promise<never>(() => {}), /超时/],
] as const) {
  test(`webhook拒绝${name}，记录错误`, async (t) => {
    const { app } = fixture(t, { webhookTransport: transport as WebhookTransport })
    await livePack(app, { ...pack, kind: 'webhook' }, { endpoint: 'https://example.com' })
    const result = await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
    assert.equal(result.status, 200)
    assert.deepEqual(result.body.cards, [])
    assert.match(result.body.error, pattern)
  })
}

test('缓存TTL、相同设置并发合并、失败保留到期前旧卡且记录安装状态', async (t) => {
  let calls = 0
  let fail = false
  const { app, advance } = fixture(t, {
    webhookTransport: async () => {
      calls++
      await new Promise((done) => setTimeout(done, 5))
      if (fail) throw new Error('接口暂不可用')
      return { status: 200, body: JSON.stringify({ cards: [card] }) }
    },
  })
  await livePack(app, { ...pack, kind: 'webhook' }, { endpoint: 'https://example.com' })
  const session = await store(app)
  await call(app, 'PUT', `/api/v1/installs/${pack.id}`, {}, session.token)
  const url = `/api/v1/plugins/${pack.id}/preview`
  await Promise.all([call(app, 'GET', url), call(app, 'GET', url)])
  await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)
  assert.equal(calls, 1)
  advance(15 * 60000)
  fail = true
  const stale = await call(app, 'GET', url)
  assert.equal(stale.body.cards.length, 1)
  assert.equal(stale.body.cards[0].expiresAt, INITIAL + 30 * 60000)
  assert.match(stale.body.error, /接口/)
  const status = (await call(app, 'GET', '/api/v1/installs', undefined, session.token)).body
    .installs[0].status
  assert.equal(status.generatedAt, INITIAL)
  assert.match(status.error, /接口/)
  advance(16 * 60000)
  assert.deepEqual((await call(app, 'GET', url)).body.cards, [])
})

test('试生成不污染缓存，公开版本更新后使用新缓存键', async (t) => {
  const { app } = fixture(t)
  const { dev, admin } = await livePack(app)
  const test = await call(
    app,
    'POST',
    `/api/v1/dev/plugins/${pack.id}/test`,
    { manifest: pack, cards: [{ ...card, text: '测试内容' }] },
    dev,
  )
  assert.equal(test.body.cards[0].text, '测试内容')
  assert.equal(test.body.error, '')
  assert.equal(
    (await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)).body.cards[0].text,
    card.text,
  )
  const v2 = await call(
    app,
    'POST',
    `/api/v1/dev/plugins/${pack.id}/versions`,
    { manifest: { ...pack, version: '2.0.0' }, cards: [{ ...card, text: '新版内容' }] },
    dev,
  )
  await approve(app, v2.body.version.id, admin)
  assert.equal(
    (await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)).body.cards[0].text,
    '新版内容',
  )
})

test('manifest、版本递增和卡片严格校验，错误返回中文422', async (t) => {
  const { app, advance } = fixture(t)
  const dev = await developer(app)
  await upload(app, dev)
  const invalidManifests = [
    { ...pack, id: 'other.pack' },
    { ...pack, version: '01.1.0' },
    { ...pack, version: '1.0' },
    { ...pack, name: '名'.repeat(25) },
    { ...pack, summary: '字'.repeat(61) },
    { ...pack, description: '字'.repeat(601) },
    { ...pack, refreshMinutes: 14 },
    { ...pack, refreshMinutes: 1441 },
    { ...pack, settings: Array(9).fill(pack.settings[0]) },
    { ...pack, settings: [{ ...pack.settings[0], default: 9 }] },
    {
      ...pack,
      settings: [{ key: 'mode', label: '模式', type: 'select', default: 'bad', options: [] }],
    },
    { ...pack, settings: [{ key: '__proto__', label: '设置', type: 'boolean', default: true }] },
  ]
  for (const manifest of invalidManifests) {
    advance(3600000)
    const result = await call(
      app,
      'POST',
      `/api/v1/dev/plugins/${pack.id}/versions`,
      { manifest, cards: [card] },
      dev,
    )
    assert.equal(result.status, 422, JSON.stringify(manifest))
    assert.match(result.body.error, /[\u4e00-\u9fff]/u)
  }
  for (const cards of [
    [],
    [card, card],
    [{ ...card, text: '字'.repeat(401) }],
    [{ ...card, life: { v: 1, kind: 'bad' } }],
    Array.from({ length: 61 }, (_, i) => ({ ...card, id: String(i) })),
  ]) {
    advance(3600000)
    const result = await call(
      app,
      'POST',
      `/api/v1/dev/plugins/${pack.id}/versions`,
      { manifest: { ...pack, version: '1.1.0' }, cards },
      dev,
    )
    assert.equal(result.status, 422)
    assert.match(result.body.error, /卡片/)
  }
  assert.equal(
    (
      await call(
        app,
        'POST',
        `/api/v1/dev/plugins/${pack.id}/versions`,
        { manifest: pack, cards: [card] },
        dev,
      )
    ).status,
    409,
  )
  assert.equal(
    (
      await call(
        app,
        'POST',
        '/api/v1/dev/plugins',
        { id: 'BAD ID', name: '名', summary: '介绍' },
        dev,
      )
    ).status,
    422,
  )
})

test('注册、登录、客户端、store-code和卡片限流，过期后恢复', async (t) => {
  const { app, advance } = fixture(t)
  for (let i = 0; i < 10; i++) {
    assert.equal((await call(app, 'POST', '/api/v1/dev/register', {})).status, 422)
    assert.equal((await call(app, 'POST', '/api/v1/dev/login', {})).status, 422)
  }
  assert.equal((await call(app, 'POST', '/api/v1/dev/register', {})).status, 429)
  assert.equal((await call(app, 'POST', '/api/v1/dev/login', {})).status, 429)
  const session = await store(app)
  for (let i = 1; i < 5; i++) assert.equal((await call(app, 'POST', '/api/v1/clients')).status, 200)
  assert.equal((await call(app, 'POST', '/api/v1/clients')).status, 429)
  for (let i = 1; i < 20; i++)
    assert.equal(
      (await call(app, 'POST', '/api/v1/clients/store-code', {}, session.client)).status,
      200,
    )
  assert.equal(
    (await call(app, 'POST', '/api/v1/clients/store-code', {}, session.client)).status,
    429,
  )
  for (let i = 0; i < 12; i++)
    assert.equal(
      (await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)).status,
      200,
      `一分钟内第${i + 1}次卡片拉取应成功`,
    )
  assert.equal(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)).status,
    429,
  )
  advance(60000)
  assert.equal(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)).status,
    200,
  )
})

test('静态商店与SPA回退，API路径返回JSON 404，不设置cookie', async (t) => {
  const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '../server-static-fixture')
  await mkdir(webDir, { recursive: true })
  await writeFile(resolve(webDir, 'index.html'), '<html>商店</html>')
  await writeFile(resolve(webDir, 'asset.js'), 'console.log(1)')
  const { app } = fixture(t, { webDir })
  for (const url of ['/', '/developer/upload', '/asset.js']) {
    const response = await app.inject(url)
    assert.equal(response.statusCode, 200, url)
    assert.equal(response.headers['set-cookie'], undefined)
  }
  assert.equal((await call(app, 'GET', '/api/v1/missing')).status, 404)
  assert.equal((await call(app, 'GET', '/api')).status, 404)
  const response = await app.inject('/api/v1/plugins')
  assert.equal(response.headers['cache-control'], 'no-store')
})

test('数据库重启保留安装，迁移和官方种子幂等', async (t) => {
  const temporary = resolve(dirname(fileURLToPath(import.meta.url)), '../server-persistence')
  await mkdir(temporary, { recursive: true })
  const directory = await mkdtemp(resolve(temporary, 'run-'))
  const dbPath = resolve(directory, 'platform.sqlite')
  const first = buildApp({ dbPath, now: () => INITIAL, fetch: hnFetch })
  let session: Awaited<ReturnType<typeof store>>
  try {
    session = await store(first)
    await call(first, 'PUT', '/api/v1/installs/codepulse.daily-poem', {}, session.token)
  } finally {
    await first.close()
  }
  const second = buildApp({ dbPath, now: () => INITIAL, fetch: hnFetch })
  t.after(async () => {
    await second.close()
    await rm(directory, { recursive: true, force: true })
  })
  assert.equal((await call(second, 'GET', '/api/v1/plugins')).body.plugins.length, 2)
  assert.equal(
    (await call(second, 'GET', '/api/v1/installs', undefined, session.token)).body.installs.length,
    1,
  )
  const db = openDatabase(dbPath)
  try {
    const client = db.prepare('SELECT token_hash FROM clients').get() as { token_hash: string }
    assert.equal(client.token_hash, tokenHash(session.client))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM versions').get() as { n: number }).n, 2)
  } finally {
    db.close()
  }
})

test('相同公开版本的不同设置使用不同缓存', async (t) => {
  let calls = 0
  const { app } = fixture(t, {
    webhookTransport: async ({ body }) => {
      calls++
      const request = JSON.parse(body)
      return {
        status: 200,
        body: JSON.stringify({ cards: [{ ...card, text: request.settings.city }] }),
      }
    },
  })
  await livePack(app, { ...pack, kind: 'webhook' }, { endpoint: 'https://example.com' })
  const session = await store(app)
  await call(
    app,
    'PUT',
    `/api/v1/installs/${pack.id}`,
    { settings: { city: '上海' } },
    session.token,
  )
  assert.equal(
    (await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)).body.cards[0].text,
    '上海',
  )
  assert.equal(
    (await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)).body.cards[0].text,
    '北京',
  )
  assert.equal(calls, 2)
})

test('DNS超时后即使解析返回，也不会发出webhook请求', async (t) => {
  let slow = false
  let resume: ((addresses: string[]) => void) | undefined
  let calls = 0
  const { app } = fixture(t, {
    resolveHost: async () =>
      slow
        ? await new Promise<string[]>((done) => {
            resume = done
          })
        : ['93.184.216.34'],
    webhookTransport: async () => {
      calls++
      return { status: 200, body: JSON.stringify({ cards: [card] }) }
    },
  })
  await livePack(app, { ...pack, kind: 'webhook' }, { endpoint: 'https://example.com' })
  slow = true
  const result = await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
  assert.match(result.body.error, /超时/)
  resume?.(['93.184.216.34'])
  await new Promise((done) => setImmediate(done))
  assert.equal(calls, 0)
})

test('webhook可以暂时返回空卡片数组且结果走缓存', async (t) => {
  let calls = 0
  const { app } = fixture(t, {
    webhookTransport: async () => {
      calls++
      return { status: 200, body: JSON.stringify({ cards: [] }) }
    },
  })
  await livePack(app, { ...pack, kind: 'webhook' }, { endpoint: 'https://example.com' })
  const url = `/api/v1/plugins/${pack.id}/preview`
  assert.deepEqual((await call(app, 'GET', url)).body, { cards: [], error: '' })
  assert.deepEqual((await call(app, 'GET', url)).body, { cards: [], error: '' })
  assert.equal(calls, 1)
})

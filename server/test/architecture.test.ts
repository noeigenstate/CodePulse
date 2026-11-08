import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizePluginSettings, isPlainText } from '@codepulse/shared'
import { buildApp } from '../src/app.js'
import { openDatabase } from '../src/db.js'
import { settingsHash } from '../src/generate/index.js'
import { localDay, packCard } from '../src/generate/pack.js'
import {
  card,
  pack,
  INITIAL,
  fixture,
  call,
  developer,
  store,
  upload,
  approve,
  livePack,
} from './helpers.js'

test('注册不能自升管理员；CLI提升已有开发者且不启动服务', async (t) => {
  const { app, dbPath } = fixture(t)
  const registered = await call(app, 'POST', '/api/v1/dev/register', {
    email: 'admin@example.com',
    password: 'password123',
    name: '管理员邮箱注册者',
    admin: true,
  })
  const token = registered.body.token
  assert.equal(registered.status, 200)
  assert.equal(registered.body.developer.admin, false)
  assert.equal((await call(app, 'GET', '/api/v1/admin/reviews', undefined, token)).status, 403)
  const cli = resolve(dirname(fileURLToPath(import.meta.url)), 'main-cli.js')
  const env = {
    ...process.env,
    CODEPULSE_PLATFORM_DB: dbPath,
    CODEPULSE_PLATFORM_PORT: 'not-a-port',
    CODEPULSE_PLATFORM_TZ: 'not-a-zone',
  }
  const result = spawnSync(process.execPath, [cli, 'admin', 'ADMIN@EXAMPLE.COM'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已设为管理员/)
  assert.doesNotMatch(result.stdout, /插件平台：/)
  assert.equal(
    (await call(app, 'GET', '/api/v1/dev/me', undefined, token)).body.developer.admin,
    true,
  )
  assert.equal((await call(app, 'GET', '/api/v1/admin/reviews', undefined, token)).status, 200)
  const login = await call(app, 'POST', '/api/v1/dev/login', {
    email: 'admin@example.com',
    password: 'password123',
  })
  assert.equal(login.body.developer.admin, true)
  const missing = spawnSync(process.execPath, [cli, 'admin', 'missing@example.com'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /开发者不存在/)
  const usage = spawnSync(process.execPath, [cli, 'admin'], {
    env,
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(usage.status, 1)
  assert.match(usage.stderr, /用法/)
})

test('v1数据库迁移到v2，已有开发者默认无管理员权限', (t) => {
  const { dbPath } = fixture(t)
  const original = openDatabase(dbPath)
  original.exec(`ALTER TABLE developers DROP COLUMN admin; PRAGMA user_version = 1;`)
  original
    .prepare(
      'INSERT INTO developers (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run('legacy', 'admin@example.com', '旧开发者', 'old-password-hash', INITIAL)
  original.close()
  const migrated = openDatabase(dbPath)
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 2)
    assert.deepEqual(
      migrated
        .prepare('SELECT name, password_hash, admin FROM developers WHERE id = ?')
        .get('legacy'),
      {
        name: '旧开发者',
        password_hash: 'old-password-hash',
        admin: 0,
      },
    )
    assert.deepEqual(migrated.prepare('SELECT DISTINCT admin FROM developers').all(), [
      { admin: 0 },
    ])
  } finally {
    migrated.close()
  }
  const reopened = openDatabase(dbPath)
  assert.equal(reopened.pragma('user_version', { simple: true }), 2)
  reopened.close()
})

test('创建插件每开发者每小时10次，不按插件或IP共享，分钟清扫不重置小时窗口', async (t) => {
  const { app, advance } = fixture(t)
  const token = await developer(app)
  for (let i = 0; i < 10; i++) {
    assert.equal(
      (
        await call(
          app,
          'POST',
          '/api/v1/dev/plugins',
          { id: `demo.plugin-${i}`, name: '插件', summary: '介绍' },
          token,
        )
      ).status,
      200,
    )
  }
  const create = () =>
    call(
      app,
      'POST',
      '/api/v1/dev/plugins',
      { id: 'demo.extra', name: '插件', summary: '介绍' },
      token,
    )
  const limited = await create()
  assert.equal(limited.status, 429)
  assert.match(limited.body.error, /请求太频繁/)
  advance(60000)
  assert.equal((await create()).status, 429)
  const other = await developer(app, 'other@example.com')
  assert.equal(
    (
      await call(
        app,
        'POST',
        '/api/v1/dev/plugins',
        { id: 'other.plugin', name: '插件', summary: '介绍' },
        other,
      )
    ).status,
    200,
  )
  advance(59 * 60000)
  assert.equal((await create()).status, 200)
})

test('提交版本每开发者每小时10次，跨插件累计', async (t) => {
  const { app, advance } = fixture(t)
  const token = await developer(app)
  for (const id of ['demo.first', 'demo.second']) {
    assert.equal(
      (await call(app, 'POST', '/api/v1/dev/plugins', { id, name: '插件', summary: '介绍' }, token))
        .status,
      200,
    )
  }
  for (let i = 0; i < 10; i++) {
    const id = i % 2 ? 'demo.second' : 'demo.first'
    assert.equal(
      (
        await call(
          app,
          'POST',
          `/api/v1/dev/plugins/${id}/versions`,
          { manifest: { ...pack, id, version: `1.0.${i}` }, cards: [card] },
          token,
        )
      ).status,
      200,
    )
  }
  const submit = () =>
    call(
      app,
      'POST',
      '/api/v1/dev/plugins/demo.first/versions',
      { manifest: { ...pack, id: 'demo.first', version: '2.0.0' }, cards: [card] },
      token,
    )
  const limited = await submit()
  assert.equal(limited.status, 429)
  assert.match(limited.body.error, /请求太频繁/)
  advance(60000)
  assert.equal((await submit()).status, 429)
  advance(59 * 60000)
  assert.equal((await submit()).status, 200)
})

test('试生成每开发者每分钟6次，跨插件累计且窗口到期恢复', async (t) => {
  const { app, advance } = fixture(t)
  const token = await developer(app)
  const other = await developer(app, 'other@example.com')
  for (const id of ['demo.first', 'demo.second']) {
    await call(app, 'POST', '/api/v1/dev/plugins', { id, name: '插件', summary: '介绍' }, token)
  }
  for (let i = 0; i < 6; i++) {
    const id = i % 2 ? 'demo.second' : 'demo.first'
    assert.equal(
      (
        await call(
          app,
          'POST',
          `/api/v1/dev/plugins/${id}/test`,
          { manifest: { ...pack, id }, cards: [card] },
          token,
        )
      ).status,
      200,
    )
  }
  const generate = () =>
    call(
      app,
      'POST',
      '/api/v1/dev/plugins/demo.first/test',
      { manifest: { ...pack, id: 'demo.first' }, cards: [card] },
      token,
    )
  const limited = await generate()
  assert.equal(limited.status, 429)
  assert.match(limited.body.error, /请求太频繁/)
  await call(
    app,
    'POST',
    '/api/v1/dev/plugins',
    { id: 'other.plugin', name: '插件', summary: '介绍' },
    other,
  )
  assert.equal(
    (
      await call(
        app,
        'POST',
        '/api/v1/dev/plugins/other.plugin/test',
        { manifest: { ...pack, id: 'other.plugin' }, cards: [card] },
        other,
      )
    ).status,
    200,
  )
  advance(60000)
  assert.equal((await generate()).status, 200)
})

test('上线只推进：新版本自动拒绝旧待审版；历史旧版获批仍不降级', async (t) => {
  const { app, dbPath } = fixture(t)
  const token = await developer(app)
  const first = await upload(app, token)
  const submit = async (version: string) => {
    const result = await call(
      app,
      'POST',
      `/api/v1/dev/plugins/${pack.id}/versions`,
      {
        manifest: { ...pack, version, name: `插件 ${version}` },
        cards: [card],
      },
      token,
    )
    assert.equal(result.status, 200)
    return result.body.version.id as string
  }
  const second = await submit('2.0.0')
  const third = await submit('3.0.0')
  const fourth = await submit('4.0.0')
  const admin = await approve(app, third)
  const mine = (await call(app, 'GET', '/api/v1/dev/plugins', undefined, token)).body.plugins[0]
  for (const id of [first.versionId, second]) {
    const version = mine.versions.find((v: { id: string }) => v.id === id)
    assert.equal(version.state, 'rejected')
    assert.equal(version.note, '已有更新版本')
  }
  assert.equal(mine.versions.find((v: { id: string }) => v.id === fourth).state, 'pending')
  const db = openDatabase(dbPath)
  try {
    // v1 deployments can already contain older pending versions beside a newer live version.
    db.prepare(
      "UPDATE versions SET state = 'pending', note = '', reviewed_at = NULL WHERE id = ?",
    ).run(second)
  } finally {
    db.close()
  }
  await approve(app, second, admin)
  const listing = (await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin
  assert.equal(listing.version, '3.0.0')
  assert.equal(listing.name, '插件 3.0.0')
  const versions = (await call(app, 'GET', '/api/v1/dev/plugins', undefined, token)).body.plugins[0]
    .versions
  assert.equal(versions.find((v: { id: string }) => v.id === second).state, 'approved')
})

test('官方前缀不可由开发者创建，官方种子不受影响', async (t) => {
  const { app } = fixture(t)
  const token = await developer(app)
  const result = await call(
    app,
    'POST',
    '/api/v1/dev/plugins',
    { id: 'codepulse.community', name: '插件', summary: '介绍' },
    token,
  )
  assert.equal(result.status, 403)
  assert.equal(result.body.error, '这个前缀保留给官方插件')
  assert.equal((await call(app, 'GET', '/api/v1/plugins/codepulse.daily-poem')).status, 200)
})

test('内容包使用配置时区；日期边界支持23小时和25小时的夏令时日期', () => {
  const now = Date.parse('2026-11-08T16:01:00Z')
  assert.equal(localDay(now).index, Date.UTC(2026, 10, 9) / 86400000)
  assert.equal(localDay(now, 'UTC').index, Date.UTC(2026, 10, 8) / 86400000)
  assert.equal(localDay(now).end, Date.parse('2026-11-09T16:00:00Z'))
  assert.equal(localDay(now, 'UTC').end, Date.parse('2026-11-09T00:00:00Z'))
  const cards = [card, { ...card, id: 'two' }]
  assert.notEqual(packCard(cards, now, 'Asia/Shanghai')[0].id, packCard(cards, now, 'UTC')[0].id)
  const spring = Date.parse('2026-03-08T05:00:00Z')
  const autumn = Date.parse('2026-11-01T04:00:00Z')
  assert.equal(localDay(spring, 'America/New_York').end - spring, 23 * 3600000)
  assert.equal(localDay(autumn, 'America/New_York').end - autumn, 25 * 3600000)
  assert.throws(() => buildApp({ dbPath: ':memory:', timeZone: 'invalid-zone' }), /时区无效/)
})

test('HN按配置时区显示时间；分数、评论、年龄和更新时间不改变id，标题和站点改变id', async (t) => {
  let title = '故\u202e事\n'
  let url = 'https://www.example.com/story'
  let points = 200
  const { app, advance } = fixture(t, {
    timeZone: 'UTC',
    fetch: async () =>
      new Response(
        JSON.stringify({
          hits: [
            {
              title,
              url,
              points,
              num_comments: points,
              created_at_i: INITIAL / 1000 - 3600,
            },
          ],
        }),
      ),
  })
  const endpoint = '/api/v1/plugins/codepulse.hn-digest/preview'
  const first = (await call(app, 'GET', endpoint)).body.cards[0]
  assert.equal(first.life.updated, '04:00')
  assert.equal(first.life.stories[0].title, '故事')
  assert.ok(isPlainText(first.life.stories[0].title, 120, true))
  advance(60 * 60000)
  points = 300
  const second = (await call(app, 'GET', endpoint)).body.cards[0]
  assert.equal(second.id, first.id)
  assert.equal(second.life.updated, '05:00')
  assert.notEqual(second.life.stories[0].age, first.life.stories[0].age)
  title = '新故事'
  advance(15 * 60000)
  const third = (await call(app, 'GET', endpoint)).body.cards[0]
  assert.notEqual(third.id, second.id)
  url = 'https://another.example.com/story'
  advance(15 * 60000)
  assert.notEqual((await call(app, 'GET', endpoint)).body.cards[0].id, third.id)
})

test('再生成清理废弃设置、旧版本和过期一天的缓存，同时保留其他客户端仍用的设置', async (t) => {
  const { app, dbPath } = fixture(t)
  const { dev, admin, versionId } = await livePack(app)
  const a = await store(app)
  const b = await store(app)
  for (const [session, city] of [
    [a, '上海'],
    [b, '广州'],
  ] as const) {
    await call(app, 'PUT', `/api/v1/installs/${pack.id}`, { settings: { city } }, session.token)
    await call(app, 'GET', '/api/v1/client/cards', undefined, session.client)
  }
  const hash = (city: string) => settingsHash(normalizePluginSettings(pack.settings, { city }))
  const db = openDatabase(dbPath)
  try {
    const has = (settings: string) =>
      Boolean(
        db
          .prepare('SELECT 1 FROM card_cache WHERE plugin_id = ? AND settings_hash = ?')
          .get(pack.id, hash(settings)),
      )
    assert.ok(has('上海'))
    assert.ok(has('广州'))
    const staleVersion = 'codepulse.daily-poem:1.0.0'
    const insert = db.prepare('INSERT INTO card_cache VALUES (?, ?, ?, ?, ?, ?, ?)')
    insert.run(
      'codepulse.daily-poem',
      staleVersion,
      'expired',
      '[]',
      '',
      INITIAL - 2 * 86400000,
      INITIAL - 86400000 - 1,
    )
    insert.run(
      'codepulse.daily-poem',
      staleVersion,
      'recent',
      '[]',
      '',
      INITIAL - 3600000,
      INITIAL - 86400000,
    )
    await call(app, 'PUT', `/api/v1/installs/${pack.id}`, { settings: { city: '杭州' } }, a.token)
    await call(app, 'GET', '/api/v1/client/cards', undefined, a.client)
    assert.equal(has('上海'), false)
    assert.ok(has('杭州'))
    assert.ok(has('广州'))
    assert.equal(
      db.prepare("SELECT 1 FROM card_cache WHERE settings_hash = 'expired'").get(),
      undefined,
    )
    assert.ok(db.prepare("SELECT 1 FROM card_cache WHERE settings_hash = 'recent'").get())
    const next = await call(
      app,
      'POST',
      `/api/v1/dev/plugins/${pack.id}/versions`,
      { manifest: { ...pack, version: '2.0.0' }, cards: [card] },
      dev,
    )
    await approve(app, next.body.version.id, admin)
    await call(app, 'GET', `/api/v1/plugins/${pack.id}/preview`)
    assert.equal(
      db.prepare('SELECT 1 FROM card_cache WHERE version_id = ?').get(versionId),
      undefined,
    )
  } finally {
    db.close()
  }
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { inspectPluginLogo, PLUGIN_LOGO_MAX_BYTES, type PluginLogoType } from '@codepulse/shared'
import { openDatabase } from '../src/db.js'
import { validateLogo } from '../src/logo.js'
import { HttpError } from '../src/validation.js'
import { administrator, approve, call, developer, fixture, pack, upload } from './helpers.js'
import { jpeg, png, webp, webpChunk, webpContainer } from './logo-images.js'

const route = `/api/v1/dev/plugins/${pack.id}/logo`
const body = (bytes: Buffer, type: PluginLogoType = 'image/png') => ({
  type,
  data: bytes.toString('base64'),
})

for (const [name, type, bytes] of [
  ['PNG', 'image/png', png()],
  ['JPEG SOF0', 'image/jpeg', jpeg()],
  ['JPEG SOF2', 'image/jpeg', jpeg(64, 64, true)],
  ['WebP VP8', 'image/webp', webp('VP8 ')],
  ['WebP VP8L', 'image/webp', webp()],
  ['WebP VP8X', 'image/webp', webp('VP8X')],
] as const) {
  test(`${name} 上传、读取原始字节及安全缓存头`, async (t) => {
    const { app, dbPath } = fixture(t)
    const dev = await developer(app)
    const { versionId } = await upload(app, dev)
    const result = await call(app, 'PUT', route, body(bytes, type), dev)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    const hash = createHash('sha256').update(bytes).digest('hex')
    assert.equal(result.body.logoUrl, `/api/v1/plugins/${pack.id}/logo?v=${hash.slice(0, 12)}`)
    // A pending plugin's logo is public so the developer and reviewer can show it immediately.
    const image = await app.inject({ url: result.body.logoUrl })
    assert.equal(image.statusCode, 200)
    assert.deepEqual(image.rawPayload, bytes)
    assert.equal(image.headers['content-type'], type)
    assert.equal(image.headers['cache-control'], 'public, max-age=86400')
    assert.equal(image.headers['x-content-type-options'], 'nosniff')
    assert.equal(image.headers['content-security-policy'], "default-src 'none'")
    assert.equal(image.headers['set-cookie'], undefined)
    const db = openDatabase(dbPath)
    try {
      assert.equal((db.prepare('SELECT hash FROM logos').get() as { hash: string }).hash, hash)
    } finally {
      db.close()
    }
    const mine = await call(app, 'GET', '/api/v1/dev/plugins', undefined, dev)
    assert.equal(mine.body.plugins[0].logoUrl, result.body.logoUrl)
    const admin = await administrator(app)
    const review = await call(app, 'GET', '/api/v1/admin/reviews', undefined, admin)
    assert.equal(review.body.reviews[0].logoUrl, result.body.logoUrl)
    await approve(app, versionId, admin)
    const listing = await call(app, 'GET', `/api/v1/plugins/${pack.id}`)
    assert.equal(listing.body.plugin.logoUrl, result.body.logoUrl)
    assert.equal(
      (await call(app, 'GET', '/api/v1/plugins?q=测试')).body.plugins[0].logoUrl,
      result.body.logoUrl,
    )
  })
}

test('logo 替换立即更新 hash，重复内容 URL 稳定，删除恢复 null', async (t) => {
  const { app } = fixture(t)
  const dev = await developer(app)
  const { versionId } = await upload(app, dev)
  const admin = await approve(app, versionId)
  const first = await call(app, 'PUT', route, body(png()), dev)
  const repeat = await call(app, 'PUT', route, body(png()), dev)
  assert.equal(first.body.logoUrl, repeat.body.logoUrl)
  const second = await call(app, 'PUT', route, body(png(64, 64, 100)), dev)
  assert.notEqual(second.body.logoUrl, first.body.logoUrl)
  assert.equal(
    (await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin.logoUrl,
    second.body.logoUrl,
  )
  assert.deepEqual((await call(app, 'DELETE', route, undefined, dev)).body, { logoUrl: null })
  assert.equal((await app.inject({ url: second.body.logoUrl })).statusCode, 404)
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin.logoUrl, null)
  assert.equal(
    (await call(app, 'GET', '/api/v1/dev/plugins', undefined, dev)).body.plugins[0].logoUrl,
    null,
  )
  assert.equal((await call(app, 'GET', '/api/v1/admin/reviews', undefined, admin)).status, 200)
  assert.deepEqual((await call(app, 'DELETE', route, undefined, dev)).body, { logoUrl: null })
})

test('拒绝 SVG、类型不符、错误 base64、大小及尺寸越界，保留原图', async (t) => {
  const { app } = fixture(t)
  const dev = await developer(app)
  await upload(app, dev)
  const original = await call(app, 'PUT', route, body(png()), dev)
  const invalidBodies = [
    { type: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
    body(Buffer.from('<svg/>')),
    body(png(), 'image/jpeg'),
    body(Buffer.alloc(PLUGIN_LOGO_MAX_BYTES + 1)),
    body(png(64, 65)),
    body(png(63)),
    body(png(1025)),
    { type: 'image/png', data: '' },
    { type: 'image/png', data: '!!!!' },
    { type: 'image/png', data: 'a===' },
    { type: 'image/png', data: 'AB==' },
    { type: 'image/png', data: 'data:image/png;base64,AAAA' },
    { type: 'image/png', data: 123 },
    null,
  ]
  for (const value of invalidBodies) {
    const response = await call(app, 'PUT', route, value, dev)
    assert.equal(response.status, 422, JSON.stringify(value))
    assert.match(response.body.error, /[\u4e00-\u9fff]/u)
  }
  const saved = await app.inject({ url: original.body.logoUrl })
  assert.deepEqual(saved.rawPayload, png())
})

test('logo 尺寸和大小的允许边界', () => {
  for (const size of [64, 1024]) {
    for (const [bytes, type] of [
      [png(size), 'image/png'],
      [jpeg(size), 'image/jpeg'],
      [jpeg(size, size, true), 'image/jpeg'],
      [webp('VP8L', size), 'image/webp'],
      [webp('VP8X', size), 'image/webp'],
    ] as const) {
      assert.doesNotThrow(() => validateLogo(body(bytes, type)))
    }
  }
  for (const [bytes, type] of [
    [jpeg(64, 63), 'image/jpeg'],
    [jpeg(63), 'image/jpeg'],
    [jpeg(1025), 'image/jpeg'],
    [webp('VP8 ', 64, 63), 'image/webp'],
    [webp('VP8L', 64, 63), 'image/webp'],
    [webp('VP8X', 64, 63), 'image/webp'],
    [webp('VP8L', 63), 'image/webp'],
    [webp('VP8X', 1025), 'image/webp'],
  ] as const) {
    assert.throws(() => validateLogo(body(bytes, type)), /正方形|边长/)
  }
  const base = png()
  const atLimit = png(64, 64, 0, PLUGIN_LOGO_MAX_BYTES - base.length - 12)
  assert.equal(atLimit.length, PLUGIN_LOGO_MAX_BYTES)
  assert.doesNotThrow(() => validateLogo(body(atLimit)))
})

test('截断及伪造 PNG/JPEG/WebP 长度都返回 422，解析不越界', () => {
  for (const [type, bytes] of [
    ['image/png', png()],
    ['image/jpeg', jpeg()],
    ['image/jpeg', jpeg(64, 64, true)],
    ['image/webp', webp('VP8 ')],
    ['image/webp', webp()],
    ['image/webp', webp('VP8X')],
  ] as const) {
    for (let length = 0; length < bytes.length; length++) {
      assert.throws(
        () => validateLogo(body(bytes.subarray(0, length), type)),
        (error) => error instanceof HttpError && error.statusCode === 422,
      )
    }
  }
  const badPng = png()
  badPng.writeUInt32BE(0xffffffff, 8)
  const badJpeg = jpeg()
  badJpeg.writeUInt16BE(0xffff, 4)
  const badWebp = webp()
  badWebp.writeUInt32LE(0xffffffff, 16)
  for (const [bytes, type] of [
    [badPng, 'image/png'],
    [badJpeg, 'image/jpeg'],
    [badWebp, 'image/webp'],
  ] as const) {
    assert.throws(
      () => validateLogo(body(bytes, type)),
      (error) => error instanceof HttpError && error.statusCode === 422,
    )
  }
  const shortChunk = webpContainer(webpChunk('VP8L', Buffer.from([0x2f])))
  const emptyCanvas = webpContainer(webpChunk('VP8X', Buffer.alloc(10)))
  for (const bytes of [shortChunk, emptyCanvas]) {
    assert.throws(() => validateLogo(body(bytes, 'image/webp')), /WebP/)
  }
})

test('只有开发者本人可以上传或删除，未登录返回 401', async (t) => {
  const { app } = fixture(t)
  const dev = await developer(app)
  await upload(app, dev)
  const other = await developer(app, 'other@example.com')
  for (const method of ['PUT', 'DELETE'] as const) {
    assert.equal(
      (await call(app, method, route, method === 'PUT' ? body(png()) : undefined)).status,
      401,
    )
    assert.equal(
      (await call(app, method, route, method === 'PUT' ? body(png()) : undefined, other)).status,
      404,
    )
  }
  assert.equal((await app.inject({ url: `/api/v1/plugins/${pack.id}/logo` })).statusCode, 404)
})

test('logo PUT/DELETE 跨插件共用每开发者每小时 20 次额度', async (t) => {
  const { app, advance } = fixture(t)
  const dev = await developer(app)
  await upload(app, dev)
  await upload(app, dev, { ...pack, id: 'demo.second' })
  for (let i = 0; i < 20; i++) {
    const id = i % 2 ? 'demo.second' : pack.id
    const method = i % 3 ? 'PUT' : 'DELETE'
    assert.equal(
      (
        await call(
          app,
          method,
          `/api/v1/dev/plugins/${id}/logo`,
          method === 'PUT' ? body(png()) : undefined,
          dev,
        )
      ).status,
      200,
    )
  }
  assert.equal((await call(app, 'PUT', route, body(png()), dev)).status, 429)
  advance(60000)
  assert.equal((await call(app, 'DELETE', route, undefined, dev)).status, 429)
  const other = await developer(app, 'other@example.com')
  await upload(app, other, { ...pack, id: 'other.pack' })
  assert.equal(
    (await call(app, 'PUT', '/api/v1/dev/plugins/other.pack/logo', body(png()), other)).status,
    200,
  )
  advance(59 * 60000)
  assert.equal((await call(app, 'PUT', route, body(png()), dev)).status, 200)
})

test('共享图标检查接受普通 Uint8Array 及有偏移的视图，拒绝尾随数据和截断', () => {
  for (const [type, image] of [
    ['image/png', png()],
    ['image/jpeg', jpeg()],
    ['image/jpeg', jpeg(64, 64, true)],
    ['image/webp', webp('VP8 ')],
    ['image/webp', webp()],
    ['image/webp', webp('VP8X')],
  ] as const) {
    const bytes = Uint8Array.from(image)
    const storage = new Uint8Array(bytes.length + 24).fill(255)
    storage.set(bytes, 11)
    for (const view of [bytes, storage.subarray(11, 11 + bytes.length)]) {
      assert.deepEqual(inspectPluginLogo(view), { type, width: 64, height: 64 })
    }
    const trailing = new Uint8Array(bytes.length + 1)
    trailing.set(bytes)
    assert.ok('error' in inspectPluginLogo(trailing))
    for (let length = 0; length < bytes.length; length++) {
      const result = inspectPluginLogo(bytes.subarray(0, length))
      assert.ok('error' in result)
      assert.match(result.error, /[\u4e00-\u9fff]/u)
    }
  }
  assert.deepEqual(inspectPluginLogo(new Uint8Array(PLUGIN_LOGO_MAX_BYTES + 1)), {
    error: '图标不能超过 200 KB',
  })
  assert.deepEqual(inspectPluginLogo(Uint8Array.from(png(64, 65))), { error: '图标必须是正方形' })
  assert.deepEqual(inspectPluginLogo(Uint8Array.from(png(63))), {
    error: '图标边长须为 64–1024 像素',
  })
  assert.deepEqual(inspectPluginLogo(Uint8Array.from(png(1025))), {
    error: '图标边长须为 64–1024 像素',
  })
})

test('仅管理员可移除其他开发者图标，删除同步到目录和开发者列表', async (t) => {
  const { app } = fixture(t)
  const dev = await developer(app)
  const { versionId } = await upload(app, dev)
  const admin = await approve(app, versionId)
  const uploaded = await call(app, 'PUT', route, body(png()), dev)
  const remove = `/api/v1/admin/plugins/${pack.id}/logo`
  assert.equal((await call(app, 'DELETE', remove)).status, 401)
  assert.equal((await call(app, 'DELETE', remove, undefined, dev)).status, 403)
  assert.equal((await app.inject({ url: uploaded.body.logoUrl })).statusCode, 200)
  const result = await call(app, 'DELETE', remove, undefined, admin)
  assert.equal(result.status, 200)
  assert.deepEqual(result.body, { logoUrl: null })
  assert.equal((await app.inject({ url: uploaded.body.logoUrl })).statusCode, 404)
  assert.equal((await call(app, 'GET', `/api/v1/plugins/${pack.id}`)).body.plugin.logoUrl, null)
  assert.equal(
    (await call(app, 'GET', '/api/v1/dev/plugins', undefined, dev)).body.plugins[0].logoUrl,
    null,
  )
  assert.equal((await call(app, 'DELETE', remove, undefined, admin)).status, 200)
  assert.equal(
    (await call(app, 'DELETE', '/api/v1/admin/plugins/missing/logo', undefined, admin)).status,
    404,
  )
})

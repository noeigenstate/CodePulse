import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import test, { type TestContext } from 'node:test'
import { PLUGIN_LOGO_MAX_BYTES } from '@codepulse/shared'
import { PluginLogoStore } from '../apps/desktop/src/main/plugin-logos.js'

function pngChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length)
  chunk.write(kind, 4)
  data.copy(chunk, 8)
  let crc = 0xffffffff
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, chunk.length - 4)
  return chunk
}

function png(width = 64, height = width, shade = 0, padding = 0): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  const pixels = Buffer.alloc((width + 1) * height, shade)
  for (let row = 0; row < height; row++) pixels[row * (width + 1)] = 0
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    ...(padding
      ? [pngChunk('tEXt', Buffer.concat([Buffer.from('p\0'), Buffer.alloc(padding - 2, 65)]))]
      : []),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const header = Buffer.from([0xff, marker, 0, 0])
  header.writeUInt16BE(data.length + 2, 2)
  return Buffer.concat([header, data])
}

function jpeg(width = 64, height = width, progressive = false): Buffer {
  const frame = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0])
  frame.writeUInt16BE(height, 1)
  frame.writeUInt16BE(width, 3)
  // Single-symbol DC/AC tables encode zero coefficients, yielding a flat gray image.
  const table = (kind: number) => Buffer.from([kind, 1, ...Array<number>(15).fill(0), 0])
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8)
  const scan = (bits: number) => {
    const data = Buffer.alloc(Math.ceil(bits / 8))
    const padding = data.length * 8 - bits
    data[data.length - 1] = (1 << padding) - 1
    return data
  }
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)])),
    jpegSegment(progressive ? 0xc2 : 0xc0, frame),
    jpegSegment(0xc4, Buffer.concat([table(0), table(0x10)])),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, progressive ? 0 : 63, 0])),
    scan(blocks * (progressive ? 1 : 2)),
    ...(progressive ? [jpegSegment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), scan(blocks)] : []),
    Buffer.from([0xff, 0xd9]),
  ])
}

function webpChunk(kind: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(8 + data.length + (data.length % 2))
  chunk.write(kind)
  chunk.writeUInt32LE(data.length, 4)
  data.copy(chunk, 8)
  return chunk
}

function webpContainer(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks])
  const header = Buffer.from('RIFF0000')
  header.writeUInt32LE(body.length, 4)
  return Buffer.concat([header, body])
}

function webp(kind: 'VP8 ' | 'VP8L' | 'VP8X' = 'VP8L', width = 64, height = width): Buffer {
  if (kind === 'VP8 ') {
    const frame = Buffer.from([0x90, 3, 0, 0x9d, 1, 0x2a, 0, 0, 0, 0])
    frame.writeUInt16LE(width, 6)
    frame.writeUInt16LE(height, 8)
    // Compressed coefficients for a constant 64×64 key frame.
    const coefficients = Buffer.from(
      '3e9148a44d25a423a2220800b0120969000013e842e300ba9a788000e44000000000',
      'hex',
    )
    return webpContainer(webpChunk('VP8 ', Buffer.concat([frame, coefficients])))
  }
  const bits: number[] = []
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i++) bits.push((value >>> i) & 1)
  }
  put(0, 3) // No transforms, color cache or meta Huffman image.
  for (const value of [0, 0, 0, 255, 0]) {
    put(1, 1)
    put(0, 1)
    put(value > 1 ? 1 : 0, 1)
    put(value, value > 1 ? 8 : 1)
  }
  const compressed = Buffer.alloc(Math.ceil(bits.length / 8))
  bits.forEach((bit, i) => {
    compressed[i >>> 3] |= bit << (i % 8)
  })
  const header = Buffer.alloc(5)
  header[0] = 0x2f
  header.writeUInt32LE((width - 1) | ((height - 1) << 14), 1)
  const lossless = webpChunk('VP8L', Buffer.concat([header, compressed]))
  if (kind === 'VP8L') return webpContainer(lossless)
  const canvas = Buffer.alloc(10)
  canvas.writeUIntLE(width - 1, 4, 3)
  canvas.writeUIntLE(height - 1, 7, 3)
  return webpContainer(webpChunk('VP8X', canvas), lossless)
}

function picture(type: 'png' | 'jpg' | 'webp' = 'png', width = 64, height = width): Buffer {
  if (type === 'jpg') return jpeg(width, height)
  if (type === 'webp') return webp('VP8L', width, height)
  return png(width, height)
}

function fixture(t: TestContext) {
  mkdirSync('.tmpshots', { recursive: true })
  const directory = mkdtempSync(join(resolve('.tmpshots'), 'plugin-logos-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let chosen: string | undefined
  let changes = 0
  let picks = 0
  const deps = {
    choose: async () => {
      picks++
      return chosen
    },
    changed: () => changes++,
  }
  const store = new PluginLogoStore(directory, deps)
  return {
    directory,
    store,
    deps,
    select: (bytes: Buffer, name = 'selected.png') => {
      chosen = join(directory, name)
      writeFileSync(chosen, bytes)
    },
    changes: () => changes,
    picks: () => picks,
  }
}

test('PNG, JPEG and WebP logos persist with hashed IDs and return only typed data URLs', async (t) => {
  const f = fixture(t)
  const id = 'local:todo'
  const hash = createHash('sha256').update(id).digest('hex')
  for (const [extension, type, size] of [
    ['png', 'image/png', 64],
    ['jpg', 'image/jpeg', 1024],
    ['webp', 'image/webp', 128],
  ] as const) {
    const bytes = picture(extension, size)
    f.select(bytes, 'chosen.' + extension)
    assert.deepEqual(await f.store.pick(id), { ok: true })
    const file = `${hash}.${extension}`
    assert.deepEqual(readdirSync(join(f.directory, 'plugin-logos')), [file])
    assert.deepEqual(JSON.parse(readFileSync(join(f.directory, 'plugin-logos.json'), 'utf8')), {
      [id]: file,
    })
    assert.deepEqual(readFileSync(join(f.directory, 'plugin-logos', file)), bytes)
    const expected = { [id]: `data:${type};base64,${bytes.toString('base64')}` }
    assert.deepEqual(f.store.list(), expected)
    assert.deepEqual(new PluginLogoStore(f.directory, f.deps).list(), expected)
  }
  assert.equal(f.changes(), 3)
  assert.deepEqual(f.store.reset(id), { ok: true })
  assert.deepEqual(f.store.list(), {})
  assert.deepEqual(readdirSync(join(f.directory, 'plugin-logos')), [])
  assert.deepEqual(new PluginLogoStore(f.directory, f.deps).list(), {})
  assert.equal(f.changes(), 4)
  assert.deepEqual(f.store.reset(id), { ok: true })
  assert.equal(f.changes(), 4)
})

test('baseline and progressive JPEG and every supported WebP container can be selected', async (t) => {
  const f = fixture(t)
  for (const bytes of [jpeg(), jpeg(64, 64, true), webp('VP8 '), webp('VP8L'), webp('VP8X')]) {
    f.select(bytes)
    assert.deepEqual(await f.store.pick('local:todo'), { ok: true })
    assert.equal(Object.keys(f.store.list()).length, 1)
  }
})

test('only the specified local IDs and platform IDs can open the logo picker', async (t) => {
  const f = fixture(t)
  for (const id of ['local:plugin', 'local:assistant', '../escape', 'UPPER', '', '__proto__']) {
    assert.deepEqual(await f.store.pick(id), { error: '插件编号无效' })
    assert.deepEqual(f.store.reset(id), { ok: true })
  }
  assert.equal(f.picks(), 0)
  for (const id of [
    'concept',
    'prompt',
    'pet',
    'calendar',
    'news',
    'social',
    'local',
    'life',
    'tools',
    'holiday',
    'headlines',
    'todo',
  ])
    assert.deepEqual(await f.store.pick(`local:${id}`), { cancelled: true })
  assert.deepEqual(await f.store.pick('codepulse.hn-digest'), { cancelled: true })
  assert.equal(f.changes(), 0)
  assert.equal(existsSync(join(f.directory, 'plugin-logos.json')), false)
})

test('invalid containers, SVG and invalid dimensions never replace an existing logo', async (t) => {
  const f = fixture(t)
  f.select(picture())
  await f.store.pick('official.poem')
  const previous = f.store.list()
  const invalid = [
    Buffer.alloc(0),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"/>'),
    Buffer.from('89504e470d0a1a0a', 'hex'),
    jpeg().subarray(0, -1),
    webp().subarray(0, -1),
    Buffer.from('not an image'),
    picture('png', 64, 65),
    picture('png', 0),
    picture('png', 63),
    picture('png', 1025),
    Buffer.alloc(PLUGIN_LOGO_MAX_BYTES + 1),
  ]
  for (const bytes of invalid) {
    f.select(bytes)
    assert.ok('error' in (await f.store.pick('official.poem')))
    assert.deepEqual(f.store.list(), previous)
  }
  assert.equal(f.changes(), 1)
})

test('the exact size limit is accepted and oversized input returns a Chinese error', async (t) => {
  const f = fixture(t)
  const bytes = png(64, 64, 0, PLUGIN_LOGO_MAX_BYTES - png().length - 12)
  assert.equal(bytes.length, PLUGIN_LOGO_MAX_BYTES)
  f.select(bytes)
  assert.deepEqual(await f.store.pick('local:pet'), { ok: true })
  f.select(Buffer.concat([bytes, Buffer.alloc(1)]))
  assert.deepEqual(await f.store.pick('local:pet'), { error: '请选择 200 KB 内的图片' })
})

test('damaged images and malformed or path-traversing indexes fall back without exposing files', async (t) => {
  const f = fixture(t)
  f.select(picture())
  await f.store.pick('local:todo')
  const files = readdirSync(join(f.directory, 'plugin-logos'))
  const cached = f.store.list()
  writeFileSync(join(f.directory, 'plugin-logos', files[0]!), 'damaged')
  assert.deepEqual(f.store.list(), cached)
  assert.deepEqual(new PluginLogoStore(f.directory, f.deps).list(), {})
  for (const value of [
    '{broken json',
    '[]',
    JSON.stringify({ 'local:todo': '../selected.png', 'local:unknown': files[0] }),
    JSON.stringify({ 'local:todo': '0'.repeat(64) + '.png' }),
  ]) {
    writeFileSync(join(f.directory, 'plugin-logos.json'), value)
    assert.deepEqual(new PluginLogoStore(f.directory, f.deps).list(), {})
  }
})

test('unreadable selections and write failures return safe errors without announcing a change', async (t) => {
  const f = fixture(t)
  const missing = new PluginLogoStore(f.directory, {
    ...f.deps,
    choose: async () => join(f.directory, 'missing-private-path'),
  })
  assert.deepEqual(await missing.pick('local:todo'), { error: '图标未能保存' })
  f.select(picture())
  mkdirSync(join(f.directory, 'plugin-logos.json.tmp'))
  assert.deepEqual(await f.store.pick('local:todo'), { error: '图标未能保存' })
  assert.deepEqual(f.store.list(), {})
  assert.deepEqual(readdirSync(join(f.directory, 'plugin-logos')), [])
  assert.equal(f.changes(), 0)
})

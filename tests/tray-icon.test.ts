import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { test } from 'node:test'
import { trayIconPngFor } from '../apps/desktop/src/main/tray-icon-png.js'

test('tray icon png renders the CodePulse app logo: dark badge, gold rim and pulse', () => {
  const image = decodeRgbaPng(trayIconPngFor('idle', 32))
  const corner = pixelAt(image, 0, 0)
  const face = pixelAt(image, 16, 8)
  const pulse = pixelAt(image, 9, 16)
  const rim = pixelAt(image, 16, 1)

  assert.equal(corner[3], 0)
  // Near-black face, as in build/icon.png.
  assert.ok(face[0] < 60 && face[1] < 60 && face[2] < 60 && face[3] === 255)
  // Gold pulse and rim: strong red/green, little blue.
  for (const gold of [pulse, rim]) {
    assert.ok(gold[0] > 200 && gold[1] > 150 && gold[2] < 120, `gold expected, got ${gold}`)
  }
})

test('tray icon adds a status dot only when agents need attention', () => {
  const idle = decodeRgbaPng(trayIconPngFor('idle', 32))
  const running = decodeRgbaPng(trayIconPngFor('running', 32))
  const dotIdle = pixelAt(idle, 26, 26)
  const dotRunning = pixelAt(running, 26, 26)

  assert.deepEqual(dotRunning.slice(0, 3), [59, 130, 246])
  assert.notDeepEqual(dotIdle.slice(0, 3), [59, 130, 246])
})

interface DecodedPng {
  width: number
  height: number
  rgba: Buffer
}

function decodeRgbaPng(buffer: Buffer): DecodedPng {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG')
  let offset = 8
  let width = 0
  let height = 0
  const idat: Buffer[] = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      assert.equal(data[8], 8)
      assert.equal(data[9], 6)
    }
    if (type === 'IDAT') idat.push(data)
    if (type === 'IEND') break
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const rgba = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const rawRow = y * (stride + 1)
    assert.equal(raw[rawRow], 0)
    raw.copy(rgba, y * stride, rawRow + 1, rawRow + 1 + stride)
  }
  return { width, height, rgba }
}

function pixelAt(image: DecodedPng, x: number, y: number): [number, number, number, number] {
  const offset = (y * image.width + x) * 4
  return [
    image.rgba[offset]!,
    image.rgba[offset + 1]!,
    image.rgba[offset + 2]!,
    image.rgba[offset + 3]!,
  ]
}

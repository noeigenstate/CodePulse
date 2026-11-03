import assert from 'node:assert/strict'
import test from 'node:test'
import { packPicture } from '../apps/desktop/src/main/ambient-image.js'
import {
  personalCard,
  restorePersonalCards,
  validRedPlane,
} from '../apps/desktop/src/main/ambient-library.js'

/** BGRA bitmap from a per-pixel RGB function. */
function bitmap(w: number, h: number, rgb: (x: number, y: number) => [number, number, number]) {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = rgb(x, y)
      out.set([b, g, r, 255], (y * w + x) * 4)
    }
  return out
}
const bits = (hex: string) => {
  const bytes = Buffer.from(hex, 'hex')
  let n = 0
  for (const v of bytes) for (let i = 0; i < 8; i++) n += (v >> i) & 1
  return n
}
const isSet = (hex: string, bit: number) =>
  (Buffer.from(hex, 'hex')[bit >> 3]! & (128 >> (bit & 7))) !== 0

test('a dark photo is tone-mapped instead of turning into a black slab', () => {
  // A dim scene: luminance 10-90 of 255 with a little texture, like an indoor night photo.
  const dark = bitmap(384, 208, (x, y) => {
    const v = 10 + Math.round((x / 383) * 60) + ((x * 7 + y * 13) % 21)
    return [v, v, v]
  })
  const picture = packPicture(dark, 384, 208)
  const share = bits(picture.imageHex) / (384 * 208)
  assert.ok(share > 0.3 && share < 0.7, `black share ${share}`)
  assert.equal(picture.red, undefined, 'red only when asked for')
})

test('saturated red becomes red ink inside one protocol-sized rectangle, never on skin or black', () => {
  const skin: [number, number, number] = [224, 172, 140]
  const scene = bitmap(384, 208, (x, y) => {
    if (x >= 20 && x < 140 && y >= 30 && y < 110) return [200, 20, 30] // a red lantern panel
    if (x >= 220 && x < 320 && y >= 60 && y < 180) return skin
    return [120, 120, 120]
  })
  const { imageHex, red } = packPicture(scene, 384, 208, { red: true })
  assert.ok(red, 'red plane produced')
  assert.equal(red.x % 8, 0)
  assert.equal(red.w % 8, 0)
  assert.ok((red.w * red.h) / 8 <= 3072)
  assert.equal(red.hex.length, (red.w * red.h) / 4)
  assert.ok(validRedPlane(red), 'passes the protocol check')
  let inside = 0,
    outside = 0
  for (let y = 0; y < red.h; y++)
    for (let x = 0; x < red.w; x++) {
      if (!isSet(red.hex, y * red.w + x)) continue
      const ax = red.x + x,
        ay = red.y + y
      assert.ok(!isSet(imageHex, ay * 384 + ax), 'red never overlaps black')
      if (ax >= 20 && ax < 140 && ay >= 30 && ay < 110) inside++
      else outside++
    }
  assert.ok(inside > 1500, `red pixels on the panel: ${inside}`)
  assert.equal(outside, 0, 'grey and skin stay black/white')
})

test('a picture with no strong red stays black and white', () => {
  const warm = bitmap(200, 100, (x) => [180 + (x % 40), 140, 110])
  assert.equal(packPicture(warm, 200, 100, { red: true }).red, undefined)
})

test('personal pictures keep a valid red plane and drop a broken one on restore', () => {
  const scene = bitmap(384, 208, (x, y) => (x < 128 && y < 96 ? [210, 25, 35] : [235, 235, 235]))
  const picture = packPicture(scene, 384, 208, { red: true })
  assert.ok(picture.red)
  const card = personalCard('image', '红灯笼', 1000, picture.imageHex, picture.red)
  assert.deepEqual(card.red, picture.red)
  const [restored] = restorePersonalCards([card], 2000)
  assert.deepEqual(restored?.red, picture.red)
  const broken = { ...card, red: { ...picture.red, x: 3 } }
  const [fallback] = restorePersonalCards([broken], 2000)
  assert.equal(fallback?.imageHex, picture.imageHex, 'the picture survives')
  assert.equal(fallback?.red, undefined, 'only red is dropped')
  assert.equal(validRedPlane({ x: 0, y: 0, w: 384, h: 208, hex: '' }), undefined, 'over 3072 bytes')
})

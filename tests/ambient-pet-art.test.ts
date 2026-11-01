import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  AMBIENT_RED_MAX_BYTES,
  PET_IDS,
  PET_MOODS,
  type PetId,
  type PetMood,
} from '@codepulse/shared'
import { renderPetArt } from '../apps/desktop/src/main/ambient-pet-art.js'

const W = 384
const H = 208

/** 1 where the black plane has ink, row-major. */
function blackPixels(hex: string): Uint8Array {
  const bytes = Buffer.from(hex, 'hex')
  const px = new Uint8Array(W * H)
  for (let i = 0; i < px.length; i++) px[i] = (bytes[i >> 3]! >> (7 - (i & 7))) & 1
  return px
}

/** Indexes (in picture coordinates) of the red pixels of a red plane. */
function redPixels(red: NonNullable<ReturnType<typeof renderPetArt>['red']>): number[] {
  const bytes = Buffer.from(red.hex, 'hex')
  const out: number[] = []
  for (let row = 0; row < red.h; row++)
    for (let col = 0; col < red.w; col++) {
      const bit = row * red.w + col
      if ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1) out.push((red.y + row) * W + red.x + col)
    }
  return out
}

const each = (fn: (id: PetId, mood: PetMood) => void) => {
  for (const id of PET_IDS) for (const mood of PET_MOODS) fn(id, mood)
}

test('every pet and mood is a 384x208 bitmap with a sensible amount of black ink', () => {
  each((id, mood) => {
    const art = renderPetArt(id, mood)
    assert.equal(art.imageHex.length, (W * H) / 4, `${id}/${mood} size`)
    assert.match(art.imageHex, /^[0-9a-f]+$/)
    const ink = blackPixels(art.imageHex).reduce((n, v) => n + v, 0)
    assert.ok(ink > 3000 && ink < 20000, `${id}/${mood} ink ${ink}`)
  })
})

test('the single red rectangle is legal, tight, byte aligned and within the MCU limit', () => {
  each((id, mood) => {
    const red = renderPetArt(id, mood).red
    assert.ok(red, `${id}/${mood} has red accents`)
    assert.equal(red.x % 8, 0, `${id}/${mood} x`)
    assert.equal(red.w % 8, 0, `${id}/${mood} w`)
    assert.ok(red.w > 0 && red.h > 0 && red.x >= 0 && red.y >= 0)
    assert.ok(red.x + red.w <= W && red.y + red.h <= H, `${id}/${mood} inside the picture`)
    assert.equal(red.hex.length, (red.w * red.h) / 4, `${id}/${mood} hex length`)
    assert.ok((red.w * red.h) / 8 <= 3072, `${id}/${mood} ${(red.w * red.h) / 8} bytes`)
    assert.ok((red.w * red.h) / 8 <= AMBIENT_RED_MAX_BYTES)
    // Tight: red ink touches the first and last row and lies in the first and last byte column.
    const px = redPixels(red)
    const ys = px.map((i) => Math.floor(i / W)),
      xs = px.map((i) => i % W)
    assert.equal(Math.min(...ys), red.y, `${id}/${mood} top`)
    assert.equal(Math.max(...ys), red.y + red.h - 1, `${id}/${mood} bottom`)
    assert.ok(Math.min(...xs) < red.x + 8 && Math.max(...xs) >= red.x + red.w - 8, `${id}/${mood}`)
  })
})

test('red and black never share a pixel and red stays an accent', () => {
  each((id, mood) => {
    const art = renderPetArt(id, mood)
    const black = blackPixels(art.imageHex)
    const px = redPixels(art.red!)
    assert.ok(px.length > 60 && px.length < 3000, `${id}/${mood} red ink ${px.length}`)
    for (const i of px)
      assert.equal(black[i], 0, `${id}/${mood} overlap at ${i % W},${(i / W) | 0}`)
  })
})

test('art is original line work: big pets, safe margins, no stray single pixels', () => {
  each((id, mood) => {
    const art = renderPetArt(id, mood)
    const px = blackPixels(art.imageHex)
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= W || y >= H ? 0 : px[y * W + x]!)
    let top = H
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!at(x, y)) continue
        assert.ok(
          x >= 4 && x < W - 4 && y >= 4 && y < H - 4,
          `${id}/${mood} ink at the edge ${x},${y}`,
        )
        if (x < 200) top = Math.min(top, y)
        const neighbours = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => at(x + dx, y + dy)))
        assert.ok(neighbours.reduce((n, v) => n + v, 0) > 1, `${id}/${mood} lone pixel ${x},${y}`)
      }
    // The pet (left part of the picture) stands at least 120 px tall above the ground line.
    assert.ok(
      196 - top >= (mood === 'sleepy' ? 85 : 120),
      `${id}/${mood} pet is ${196 - top}px tall`,
    )
  })
})

test('every pet and mood has its own picture, cached and deterministic', () => {
  const seen = new Set<string>()
  each((id, mood) => {
    const art = renderPetArt(id, mood)
    assert.equal(renderPetArt(id, mood), art, 'same object for the same arguments')
    seen.add(art.imageHex)
  })
  assert.equal(seen.size, PET_IDS.length * PET_MOODS.length)
  const source = readFileSync('apps/desktop/src/main/ambient-pet-art.ts', 'utf8')
  assert.doesNotMatch(source, /Math\.random|Date\.now|new Date|performance\.now/)
})

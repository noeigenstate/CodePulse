import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeDeviceLife, type AmbientCard } from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { CONCEPTS, PROMPTS, heroCharacters } from '../apps/desktop/src/main/ambient-reading.js'
import { builtinCards } from '../apps/desktop/src/main/ambient-library.js'
import { collectNews } from '../apps/desktop/src/main/ambient-sources.js'
import { deviceCard, withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import { deviceLife } from '../apps/desktop/src/main/device-life.js'
import { deviceText } from '../apps/desktop/src/main/device-text.js'
import { createDevicePlaneRenderer } from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'

const now = new Date(2026, 10, 4, 9, 30).getTime()
const len = (s: string) => Array.from(s).length

test('built-in concepts and prompts stay inside the device limits and its glyph set', () => {
  assert.ok(CONCEPTS.length >= 24 && PROMPTS.length >= 16)
  assert.equal(new Set(CONCEPTS.map((c) => c.id)).size, CONCEPTS.length)
  assert.equal(new Set(PROMPTS.map((p) => p.id)).size, PROMPTS.length)
  for (const c of CONCEPTS) {
    assert.ok(len(c.subject) <= 6 && len(c.term) <= 6, c.id)
    assert.ok(/^[\x20-\x7e]{0,24}$/.test(c.english), c.id + ' english')
    assert.ok(len(c.definition) <= 44 && len(c.example) <= 44 && len(c.question) <= 20, c.id)
    assert.match(c.url, /^https:\/\/(openstax\.org|plato\.stanford\.edu)\//)
  }
  for (const p of PROMPTS) {
    assert.ok(len(p.tag) <= 6 && len(p.lead) <= 22 && len(p.follow) <= 23, p.id)
    assert.ok(
      p.question.every((line) => len(line) >= 1 && len(line) <= 11),
      p.id,
    )
  }
  for (const card of builtinCards(now)) {
    assert.equal(card.layout, 'life')
    assert.ok(normalizeDeviceLife(card.life), card.id + ' shape')
    // Chinese prose keeps its full-width punctuation on the device.
    assert.deepEqual(deviceLife(card.life), card.life, card.id + ' device glyphs')
  }
})

test('every large-line character is in the firmware 32px strike', () => {
  const charset = new Set(
    Array.from(readFileSync('firmware/fonts/sources/card-hero-charset.txt', 'utf8').trim()),
  )
  const strike = JSON.parse(readFileSync('firmware/fonts/sources/card-hero-masks.json', 'utf8'))
  const codes = new Set<number>(strike.glyphs.map((g: { code: number }) => g.code))
  // The device receives ASCII punctuation (deviceText folds full-width forms); the firmware
  // draws such a character with the strike's full-width glyph.
  const wide = (c: string) =>
    /[!-/:-@[-`{-~]/.test(c) ? String.fromCodePoint(c.codePointAt(0)! + 0xfee0) : c
  const sent = Array.from(
    heroCharacters()
      .map((c) => deviceText(c))
      .join(''),
  )
  const missing = sent.map(wide).filter((c) => !charset.has(c) || !codes.has(c.codePointAt(0)!))
  assert.deepEqual(
    missing,
    [],
    'add these to card-hero-charset.txt and run generate-card-hero.py --rasterize',
  )
  // Native size only: one CJK advance is the 32px em, so 11 characters fit the 376px line.
  for (const g of strike.glyphs) assert.ok(g.advance <= 32 && g.height <= 40, String(g.code))
  assert.equal(strike.recipe.scaling, 'none')
})

test('concept and prompt cards reach the device as their own life kinds', () => {
  const cards = builtinCards(now)
  const concept = cards.find((c) => c.id === 'concept:economics-cost')!
  const prompt = cards.find((c) => c.id === 'prompt:reverse')!
  const device = deviceCard(concept)
  assert.equal(device.layout, 'life')
  assert.equal(device.life?.kind, 'concept')
  if (device.life?.kind === 'concept') {
    assert.equal(device.life.term, '机会成本')
    assert.equal(device.life.position, `1 / ${CONCEPTS.length}`)
  }
  assert.ok(device.text.startsWith('机会成本：'), 'old firmware keeps a readable text')
  assert.equal(deviceCard(prompt).life?.kind, 'prompt')
  // A payload that does not match the card's kind is never sent.
  const mixed = { ...concept, life: prompt.life } as AmbientCard
  assert.equal(deviceCard(mixed).life, undefined)
  assert.equal(deviceCard(mixed).layout, undefined)
})

test('the tech digest keeps the four most-voted stories in one card with a stable id', async () => {
  const hit = (id: number, points: number, minutesAgo: number, url?: string) => ({
    objectID: String(id),
    title: `Story ${id}`,
    points,
    num_comments: id * 10,
    created_at_i: Math.floor((now - minutesAgo * 60000) / 1000),
    ...(url ? { url } : {}),
  })
  const page = (bump: number) => async () => ({
    hits: [
      hit(1, 150 + bump, 30, 'https://www.example.com/a'),
      hit(2, 480 + bump, 90),
      hit(3, 320, 200, 'https://blog.example.org/b'),
      hit(4, 99, 10),
      hit(5, 210, 45),
      hit(6, 120, 5),
    ],
  })
  const [card] = await collectNews(now, page(0))
  assert.ok(card)
  assert.equal(card.kind, 'news')
  assert.equal(card.score, 480)
  assert.equal(card.life?.kind, 'hn')
  if (card.life?.kind !== 'hn') return
  assert.deepEqual(
    card.life.stories.map((s) => [s.title, s.points, s.comments, s.site, s.age]),
    [
      ['Story 2', 480, 20, '', '1 小时前'],
      ['Story 3', 320, 30, 'blog.example.org', '3 小时前'],
      ['Story 5', 210, 50, '', '45 分钟前'],
      ['Story 1', 150, 10, 'example.com', '30 分钟前'],
    ],
  )
  assert.equal(card.life.updated, '09:30')
  assert.equal(card.text, 'Story 2 · Story 3 · Story 5')
  const [again] = await collectNews(now, page(7))
  assert.equal(again!.id, card.id, 'points moving does not make a new card')
  const device = deviceCard(card)
  assert.equal(device.life?.kind, 'hn')
  assert.notEqual(deviceCard(again!).id, device.id, 'but the device redraws the new points')
})

test('the production renderer draws the reading layouts, not the plain text card', async () => {
  const render = await createDevicePlaneRenderer(
    readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'),
  )
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  const [hn] = await collectNews(now, async () => ({
    hits: [
      {
        objectID: '1',
        title: 'Example story',
        points: 300,
        num_comments: 12,
        created_at_i: now / 1000 - 600,
      },
    ],
  }))
  for (const card of [
    builtinCards(now).find((c) => c.kind === 'concept')!,
    builtinCards(now).find((c) => c.kind === 'prompt')!,
    hn!,
  ]) {
    const layout = render(withAmbient(base, card))
    const { layout: _layout, life: _life, ...plain } = card
    const text = render(withAmbient(base, plain))
    assert.notDeepEqual(Buffer.from(layout.black), Buffer.from(text.black), card.id)
    assert.ok(
      layout.red.some((v) => v !== 0xff),
      card.id + ' uses red accents',
    )
    for (let i = 0; i < 15000; i++) assert.equal(layout.black[i]! | layout.red[i]!, 255)
    if (card.kind === 'prompt') {
      // The first question line is drawn by the native 32px strike, not the 16px fallback.
      let rows = 0
      for (let y = 92; y < 132; y++) {
        let ink = false
        for (let x = 12; x < 388 && !ink; x++)
          ink = (layout.black[(y * 400 + x) >> 3]! & (128 >> (x & 7))) === 0
        if (ink) rows++
      }
      assert.ok(rows >= 26, `32px question line, ${rows} rows of ink`)
    }
  }
})

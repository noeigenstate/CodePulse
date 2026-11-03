import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { normalizeAmbient, normalizeDeviceLife, type DeviceLife } from '@codepulse/shared'
import { deviceLife } from '../apps/desktop/src/main/device-life.js'
import { deviceSupports } from '../apps/desktop/src/main/device-text.js'
import { deviceCard, withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import {
  YuanbaoSource,
  type YuanbaoCache,
} from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import {
  weatherCard,
  goldCard,
  stockCard,
  toolCard,
  newsCard,
  holidayCard,
  holidayPendingCard,
  holidayLife,
  yuanbaoPages,
  yuanbaoSample,
  yuanbaoGoldPresentation,
  zonedParts,
} from '../apps/desktop/src/main/ambient-yuanbao.js'

const now = Date.parse('2026-11-02T15:36:30Z')
const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/yuanbao/${name}.json`, 'utf8'))
const pages = (name: string) => yuanbaoPages(fixture(name))
const base = () => toDeviceStatusV1(new StatusHub().snapshot())
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const synthetic = (name: string): DeviceLife =>
  JSON.parse(readFileSync(`firmware/preview/fixtures/life-${name}.json`, 'utf8')).ambient.life
function everyString(value: unknown) {
  if (typeof value === 'string') assert.ok(deviceSupports(value), value)
  else if (Array.isArray(value)) value.forEach(everyString)
  else if (value && typeof value === 'object') Object.values(value).forEach(everyString)
}

test('life: every approved fixture satisfies the same bounded versioned desktop contract', () => {
  for (const name of [
    'weather',
    'gold',
    'stock-down',
    'stock-up',
    'stock-closed',
    'tool-codex',
    'tool-claude',
    'news',
    'holiday-yes',
    'holiday-none',
  ]) {
    const life = synthetic(name)
    assert.deepEqual(normalizeDeviceLife(life), life)
    const prepared = deviceLife(life)
    assert.ok(prepared)
    everyString(prepared)
    assert.ok(bytes(prepared) < 1500, name)
  }
})
test('life: live gold projects real prices, direction, daily range and brand without replacing text', () => {
  const card = goldCard(pages('live-gold'), true, now)!
  assert.equal(card.layout, 'life')
  assert.equal(card.life?.kind, 'gold')
  if (card.life?.kind !== 'gold') return
  assert.deepEqual(
    [
      card.life.hero,
      card.life.direction,
      card.life.percent,
      card.life.change,
      card.life.low,
      card.life.high,
    ],
    ['844.92', 'up', '2.01%', '+16.62', '829.39', '847.78'],
  )
  assert.deepEqual(
    [
      card.life.international,
      card.life.internationalPercent,
      card.life.brand,
      card.life.brandPrice,
    ],
    ['3952.79', '+2.01%', '周大福', '1173'],
  )
  const projected = deviceCard(card)
  assert.equal(projected.text, card.text)
  assert.deepEqual(projected.life, card.life)
  assert.equal(projected.imageHex, undefined)
  assert.equal(projected.red, undefined, 'firmware draws red; no 3072-byte desktop bitmap')
})
test('life: live stock fields retain the actual AAPL quote and market state', () => {
  const card = stockCard(pages('live-stock'), 'aapl.us', now)
  assert.equal(card.life?.kind, 'stock')
  if (card.life?.kind !== 'stock') return
  assert.deepEqual(
    [
      card.life.name,
      card.life.symbol,
      card.life.hero,
      card.life.direction,
      card.life.percent,
      card.life.change,
    ],
    ['苹果', 'AAPL.US', '340.57', 'down', '1.18%', '-4.06'],
  )
  assert.deepEqual(
    [card.life.state, card.life.low, card.life.high, card.life.open, card.life.previous],
    ['open', '339.61', '343.78', '342.67', '344.63'],
  )
  const closed = stockCard(
    pages('live-stock').map((p) => ({ ...p, passage: p.passage.replace('交易中', '休市') })),
    'aapl.us',
    now,
  )
  assert.equal(closed.life?.kind === 'stock' && closed.life.state, 'closed')
})
test('life: real weather uses parsed today fields and does not invent the truncated tomorrow condition', () => {
  const time = Date.parse('2026-10-30T07:33:41Z')
  const card = weatherCard(pages('yuanbao-weather-m1'), '北京', time)!
  assert.equal(card.life?.kind, 'weather')
  if (card.life?.kind !== 'weather') return
  assert.deepEqual(
    [
      card.life.icon,
      card.life.low,
      card.life.high,
      card.life.condition,
      card.life.feels,
      card.life.humidity,
      card.life.air,
    ],
    ['sun', '4', '22', '晴', '15', '32', '60'],
  )
  assert.equal(card.life.tomorrow, undefined)
  assert.match(card.text, /明天 — 6–12℃/)
})
test('life: real tools use the selected release prose and never fabricate a command', () => {
  const card = toolCard(pages('live-tools'), 'Codex', now)!
  assert.equal(card.life?.kind, 'tool')
  if (card.life?.kind !== 'tool') return
  assert.equal(card.life.icon, 'codex')
  assert.equal(card.life.command, '')
  assert.match(card.life.title, /Codex 大更新/)
  assert.match(card.life.summary, /Codex 这次的动作核心/)
  assert.equal(card.life.date, '11-02')
  const page = {
    ...pages('live-tools')[0]!,
    title: 'Codex v2.0 发布',
    date: '2026-11-02',
    passage: 'codex doctor 用来检查本地安装、配置、认证和运行时健康状态。',
  }
  const actual = toolCard([page], 'Codex', now)!
  assert.equal(actual.life?.kind === 'tool' && actual.life.command, 'codex doctor')
})
test('life: live news keeps only supported real headlines, with no made-up rows', () => {
  const card = newsCard(pages('live-news'), now)!
  assert.equal(card.life?.kind, 'news')
  if (card.life?.kind !== 'news') return
  assert.equal(card.life.headlines.length, 2)
  assert.match(card.life.headlines[1]!.title, /商品服务、实体云端/)
  everyString(card.life)
  const four = newsCard(
    Array.from({ length: 5 }, (_, i) => ({ ...pages('live-news')[1]!, title: `标题${i}` })),
    now,
  )!
  assert.equal(four.life?.kind === 'news' && four.life.headlines.length, 4)
  assert.equal(
    four.text.split(' · ').length,
    3,
    'old text layout retains its bounded three-title content',
  )
})
test('life: pending holiday countdown is China civil-date arithmetic without a guessed break', () => {
  const time = Date.parse('2026-11-03T04:00:00Z'),
    card = holidayPendingCard(2027, time)
  assert.equal(card.life?.kind, 'holiday')
  if (card.life?.kind !== 'holiday') return
  assert.equal(card.life.state, 'pending')
  assert.deepEqual(card.life.next, { name: '元旦', date: '2027-01-01', days: 59 })
  assert.equal(card.life.range, undefined)
  assert.match(card.text, /距 2027 元旦 59 天/)
  assert.equal(holidayLife(2027, 'pending', Date.parse('2027-01-01T04:00:00Z')).next.days, 0)
  assert.equal(holidayLife(2027, 'pending', Date.parse('2027-01-02T04:00:00Z')).next.name, '劳动节')
})
test('life: countdown follows China dates across UTC midnight and host DST timezones', () => {
  const clock = Date.parse('2026-11-02T23:30:00Z')
  const script = `const zoneFormat=new Map();const zonedParts=(${zonedParts.toString()});const f=(${holidayLife.toString()});process.stdout.write(JSON.stringify(f(2027,'pending',${clock}).next));`
  const run = (zone: string) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: { ...process.env, TZ: zone },
      }),
    )
  assert.equal(run('Asia/Shanghai').days, 59)
  assert.equal(run('America/New_York').days, 59)
})
test('life: holiday speculation stays pending; a published range needs actual valid notice dates', () => {
  assert.equal(holidayCard(pages('live-holiday'), 2027, now), undefined)
  const official = {
    ...pages('live-holiday')[0]!,
    title: '国务院办公厅关于2027年部分节假日安排的通知',
    url: 'https://www.gov.cn/notice/2027',
    site: '中国政府网',
    passage: '国务院办公厅通知。一、元旦：2027年1月1日至1月3日放假，共3天。',
  }
  const card = holidayCard([official], 2027, now)!
  assert.equal(card.life?.kind, 'holiday')
  if (card.life?.kind !== 'holiday') return
  assert.equal(card.life.state, 'published')
  assert.deepEqual(card.life.range, {
    name: '元旦',
    start: '2027-01-01',
    end: '2027-01-03',
    days: 3,
  })
  const without = holidayCard(
    [{ ...official, passage: '国务院办公厅已发布通知，详细日历将另行同步。' }],
    2027,
    now,
  )!
  assert.equal(without.life?.kind === 'holiday' && without.life.range, undefined)
  const impossible = holidayCard(
    [{ ...official, passage: '元旦：2027年2月30日至2月31日放假。' }],
    2027,
    now,
  )!
  assert.equal(impossible.life?.kind === 'holiday' && impossible.life.range, undefined)
  const past = holidayCard(
    [{ ...official, passage: '元旦：2026年1月1日至1月3日放假，仅供往年参考。' }],
    2027,
    now,
  )!
  assert.equal(past.life?.kind === 'holiday' && past.life.range, undefined)
  const cross = holidayCard(
    [{ ...official, passage: '元旦：2026年12月31日至2027年1月2日放假，共3天。' }],
    2027,
    now,
  )!
  assert.equal(cross.life?.kind === 'holiday' && cross.life.range?.days, 3)
})
test('life: malformed, partial and future payloads retain a plain text card under the plain id', () => {
  const card = stockCard(pages('live-stock'), 'aapl.us', now),
    plain = deviceCard({ ...card, layout: undefined, life: undefined })
  for (const bad of [
    undefined,
    null,
    [],
    true,
    { v: 2, kind: 'stock' },
    { ...card.life, hero: '12%' },
    { ...card.life, hero: 'x'.repeat(17) },
    { ...card.life, state: { toString: null } },
    { ...card.life, direction: { toString: null } },
    { ...card.life, source: 'x\u0000y' },
    { ...synthetic('weather'), sunset: '99:99' },
    { ...synthetic('news'), headlines: Array(5).fill({ title: '标题', source: '' }) },
  ]) {
    assert.equal(deviceLife(bad), undefined)
    assert.deepEqual(deviceCard({ ...card, life: bad as DeviceLife }), plain)
  }
  assert.equal(deviceCard({ ...card, topic: 'weather' }).life, undefined)
})
test('life: every field is charset filtered, including nested metadata and summaries beyond truncation', () => {
  const valid = synthetic('tool-codex')
  for (const bad of [
    { ...valid, name: '統' },
    { ...valid, summary: '支持的正文'.repeat(10) + '😀' },
    { ...valid, source: '來源' },
  ])
    assert.equal(deviceLife(bad), undefined)
  assert.equal(deviceLife({ ...valid, name: 'Ｃｏｄｅｘ' })?.kind, 'tool')
  everyString(deviceLife({ ...valid, name: 'Ｃｏｄｅｘ' }))
})
test('life: payload identity, revision and size fallback include every structured field', () => {
  const card = stockCard(pages('live-stock'), 'aapl.us', now),
    status = base(),
    before = JSON.stringify(card)
  const projected = withAmbient(status, card),
    plain = withAmbient(status, { ...card, layout: undefined, life: undefined })
  assert.equal(projected.ambient?.layout, 'life')
  assert.notEqual(projected.revision, plain.revision)
  if (card.life?.kind !== 'stock') return
  const changed = { ...card, life: { ...card.life, high: '345.00' } }
  assert.notEqual(deviceCard(changed).id, deviceCard(card).id)
  const tight = { ...status, message: 'x'.repeat(32000 - bytes(plain) - 10) },
    reduced = withAmbient(tight, card)
  assert.equal(reduced.ambient?.text, card.text)
  assert.equal(reduced.ambient?.life, undefined)
  assert.equal(reduced.ambient?.layout, undefined)
  assert.equal(reduced.ambient?.id, plain.ambient?.id)
  assert.ok(bytes(reduced) <= 32000)
  assert.equal(JSON.stringify(card), before)
})
test('life: raw saved cards retain their validated payload while invalid extensions fall back', async () => {
  const card = stockCard(pages('live-stock'), 'aapl.us', now)
  const source = new YuanbaoSource({
    config: () => normalizeAmbient({ yuanbao: { stocksEnabled: true, stocks: ['aapl.us'] } }),
    credentials: () => null,
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    cache: { entries: [{ key: 'stock:aapl.us', card }] },
  })
  assert.deepEqual(source.cards()[0]?.life, card.life)
  const bad = new YuanbaoSource({
    config: () => normalizeAmbient({ yuanbao: { stocks: ['aapl.us'] } }),
    credentials: () => null,
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    cache: { entries: [{ key: 'stock:aapl.us', card: { ...card, life: { v: 999 } } }] },
  })
  assert.equal(bad.cards()[0]?.text, card.text)
  assert.equal(bad.cards()[0]?.life, undefined)
})
test('life: pending countdown updates after China midnight without spending quota or extending expiry', async () => {
  let clock = Date.parse('2026-11-03T15:59:00Z'),
    saved: YuanbaoCache | undefined,
    calls = 0
  const source = new YuanbaoSource({
    config: () =>
      normalizeAmbient({
        enabled: true,
        quietStart: 0,
        quietEnd: 0,
        yuanbao: { enabled: true, holidayEnabled: true },
      }),
    credentials: () => ({ apiKey: 'obviously-fake-life-test-key' }),
    now: () => clock,
    holidays: () => ({}),
    hasYear: () => false,
    save: (cache) => {
      saved = cache
    },
    changed() {},
    client: {
      search: async () => {
        calls++
        return { raw: {}, pages: pages('live-holiday'), latencyMs: 0, edition: 'standard' }
      },
    },
  })
  await source.tick()
  const first = source.cards()[0]!
  assert.equal(source.snapshot().holiday?.state, 'pending')
  assert.equal(saved?.published['2027'], undefined)
  clock = Date.parse('2026-11-03T16:01:00Z')
  const next = source.cards()[0]!
  assert.notEqual(next.id, first.id)
  assert.equal(next.expiresAt, first.expiresAt)
  assert.equal(next.life?.kind === 'holiday' && next.life.next.days, 58)
  assert.ok(source.accepts(next))
  assert.equal(calls, 1)
})
test('life: gold brand presentation removes both text and structured brand without another query', () => {
  const card = goldCard(pages('live-gold'), true, now)!,
    hidden = yuanbaoGoldPresentation(card, false)
  assert.doesNotMatch(hidden.text, /周大福/)
  assert.equal(hidden.life?.kind === 'gold' && hidden.life.brand, '')
  assert.equal(hidden.life?.kind === 'gold' && hidden.life.brandPrice, '')
})
test('life: built-in previews are explicitly samples and every topic has the new structured layout', () => {
  for (const topic of ['weather', 'gold', 'stock', 'tools', 'holiday', 'news'] as const) {
    const card = yuanbaoSample(topic, now)
    assert.ok(card.source.endsWith('示例'))
    assert.equal(card.score, 0)
    assert.equal(deviceCard(card).layout, 'life')
    everyString(card.life)
  }
})
test('life: normalizeAmbient remains strict and no new settings can silently enable paid features', () => {
  assert.deepEqual(
    normalizeAmbient({ life: synthetic('gold'), yuanbao: { life: synthetic('gold') } }),
    normalizeAmbient(undefined),
  )
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { normalizeAmbient } from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import {
  holidayCard,
  holidayLife,
  holidayPendingCard,
  holidayWatchYear,
  stockCard,
  toolCard,
  weatherCard,
  yuanbaoPages,
} from '../apps/desktop/src/main/ambient-yuanbao.js'
import { YuanbaoSource } from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import { deviceCard, withAmbient } from '../apps/desktop/src/main/ambient-rules.js'
import { deviceSupports } from '../apps/desktop/src/main/device-text.js'

const fixture = (name: string) =>
  yuanbaoPages(JSON.parse(readFileSync(`tests/fixtures/yuanbao/${name}.json`, 'utf8')))
const notice = (passage: string) => ({
  ...fixture('live-holiday')[0]!,
  title: '国务院办公厅关于2027年部分节假日安排的通知',
  site: '中国政府网',
  date: '2026-11-02',
  url: 'https://www.gov.cn/notices/2027',
  passage,
})

test('review 2: published countdown and fallback text refresh at presentation without changing range, expiry or stored card', () => {
  const fetched = Date.parse('2026-11-03T15:59:00Z')
  let clock = fetched
  const card = holidayCard([notice('元旦：2027年1月1日至1月3日放假，共3天。')], 2027, fetched)!
  assert.equal(card.life?.kind, 'holiday')
  if (card.life?.kind !== 'holiday') return
  const saved = { ...card, text: card.text + ' · 距2027元旦59天' }
  const original = JSON.stringify(saved)
  const source = new YuanbaoSource({
    config: () => normalizeAmbient({ yuanbao: { holidayEnabled: true } }),
    credentials: () => null,
    now: () => clock,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    cache: { entries: [{ key: 'holiday:2027', card: saved }] },
  })
  const first = source.cards()[0]!
  clock = Date.parse('2026-11-03T16:01:00Z')
  const next = source.cards()[0]!
  assert.equal(next.life?.kind === 'holiday' && next.life.next.days, 58)
  assert.match(next.text, /距 2027 元旦 58 天/)
  assert.deepEqual(next.life?.kind === 'holiday' && next.life.range, card.life.range)
  assert.equal(next.expiresAt, card.expiresAt)
  assert.equal(next.publishedAt, card.publishedAt)
  assert.notEqual(deviceCard(first).id, deviceCard(next).id)
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  assert.notEqual(withAmbient(base, first).revision, withAmbient(base, next).revision)
  assert.equal(JSON.stringify(saved), original)
})
test('review 2: published countdown advances to the next fixed holiday while retaining the announced range', () => {
  let clock = Date.parse('2026-12-31T15:00:00Z')
  const card = holidayCard([notice('元旦：2027年1月1日至1月3日放假，共3天。')], 2027, clock)!
  const source = new YuanbaoSource({
    config: () => normalizeAmbient(undefined),
    credentials: () => null,
    now: () => clock,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
  })
  clock = Date.parse('2027-01-01T16:01:00Z')
  const shown = source.present(card)
  assert.deepEqual(shown.life?.kind === 'holiday' && shown.life.next, {
    name: '劳动节',
    date: '2027-05-01',
    days: 119,
  })
  assert.deepEqual(
    shown.life?.kind === 'holiday' && shown.life.range,
    card.life?.kind === 'holiday' && card.life.range,
  )
})
test('review 4: skip past holiday ranges and retain the first range whose end is today or later', () => {
  const page = notice(
    '元旦：2027年1月1日至1月3日放假。春节：2027年2月5日至2月12日放假。劳动节：2027年5月1日至5月5日放假。',
  )
  const range = (clock: string) => {
    const card = holidayCard([page], 2027, Date.parse(clock))!
    return card.life?.kind === 'holiday' ? card.life.range : undefined
  }
  assert.equal(range('2027-01-03T15:59:00Z')?.name, '元旦')
  assert.equal(range('2027-01-03T16:01:00Z')?.name, '春节')
  assert.equal(range('2027-02-12T16:01:00Z')?.name, '劳动节')
  assert.equal(range('2027-05-05T16:01:00Z'), undefined)
})
test('review 5: watch, countdown and pending identity all use China dates at midnight regardless of host timezone', () => {
  const saved = process.env.TZ
  try {
    for (const zone of ['UTC', 'Asia/Shanghai', 'America/New_York', 'Pacific/Honolulu']) {
      process.env.TZ = zone
      const before = Date.parse('2026-12-31T15:59:00Z'),
        after = Date.parse('2026-12-31T16:01:00Z')
      assert.equal(holidayWatchYear(before), 2027)
      assert.equal(holidayWatchYear(after), 2027)
      assert.equal(holidayLife(2027, 'pending', before).next.days, 1)
      assert.equal(holidayLife(2027, 'pending', after).next.days, 0)
      assert.match(holidayPendingCard(2027, before).id, /pending:2026-12-31$/)
      assert.match(holidayPendingCard(2027, after).id, /pending:2027-01-01$/)
      assert.equal(holidayWatchYear(Date.parse('2027-01-31T15:59:00Z')), 2027)
      assert.equal(holidayWatchYear(Date.parse('2027-01-31T16:01:00Z')), null)
    }
  } finally {
    if (saved === undefined) delete process.env.TZ
    else process.env.TZ = saved
  }
})
test('review 6: pre-market and after-market remain neutral unknown instead of claiming closed', () => {
  for (const state of ['盘前', '盘后']) {
    const pages = fixture('live-stock').map((p) => ({
      ...p,
      passage: p.passage.replace('交易中', state),
    }))
    const card = stockCard(pages, 'aapl.us', Date.parse('2026-11-02T15:36:30Z'))
    assert.equal(card.life?.kind === 'stock' && card.life.state, 'unknown')
    assert.ok(card.text.includes(state))
  }
})
test('review 7: tool metadata is decoded, glyph filtered and ellipsized without discarding the structured card', () => {
  const page = {
    ...fixture('live-tools')[0]!,
    title: '<b>Ｃｏｄｅｘ v2.0 更新 ' + '版本说明'.repeat(20) + '</b>',
    site: '<b>测试 &amp; 来源　ＡＩ站点名称很长</b>',
    date: '2026-11-02',
    passage: 'Codex 新增了会话筛选功能并修复多个连接问题。',
  }
  const card = toolCard([page], 'Codex', Date.parse('2026-11-02T15:36:30Z'))!
  assert.equal(card.life?.kind, 'tool')
  if (card.life?.kind !== 'tool') return
  assert.ok(card.life.title.endsWith('…'))
  assert.equal(Array.from(card.life.title).length, 48)
  assert.ok(card.life.source.endsWith('…'))
  assert.equal(Array.from(card.life.source).length, 8)
  assert.doesNotMatch(card.life.title + card.life.source, /<b>|&amp;|Ｃ|Ａ|　/)
  assert.ok(deviceSupports(card.life.title + card.life.source))
  const unsupported = toolCard(
    [{ ...page, site: '来源😀' }],
    'Codex',
    Date.parse('2026-11-02T15:36:30Z'),
  )!
  assert.equal(unsupported.life?.kind === 'tool' && unsupported.life.source, '')
})
for (const humidity of ['32%', '３２％']) {
  test(`review 8: weather accepts ${humidity} without a double percent or layout fallback`, () => {
    const pages = fixture('yuanbao-weather-m1').map((p) => ({
      ...p,
      passage: p.passage.replaceAll('湿度：32', '湿度：' + humidity),
    }))
    const card = weatherCard(pages, '北京', Date.parse('2026-10-30T07:33:41Z'))!
    assert.match(card.text, /湿度32%/)
    assert.doesNotMatch(card.text, /32%%/)
    assert.equal(card.layout, 'life')
    assert.equal(card.life?.kind === 'weather' && card.life.humidity, '32')
  })
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { normalizeAmbient, type YuanbaoConfig } from '@codepulse/shared'
import {
  quoteTradingTime,
  holidayWatchYear,
  YuanbaoClient,
  type YuanbaoCredentials,
} from '../apps/desktop/src/main/ambient-yuanbao.js'
import {
  YuanbaoSource,
  type YuanbaoCache,
} from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { contentKey, qualifies } from '../apps/desktop/src/main/ambient-rules.js'
import { StatusHub } from '@codepulse/core'

const now = Date.parse('2026-10-30T07:33:41Z')
const response = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/yuanbao/yuanbao-${name}.json`, 'utf8')).response
const localHour = new Date(now).getHours()
const localDay = (time: number) => {
  const d = new Date(time)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
function fixture(
  options: {
    yuanbao?: Partial<YuanbaoConfig>
    key?: YuanbaoCredentials | null
    quiet?: [number, number]
    cache?: unknown
    fail?: boolean
    failSave?: boolean
  } = {},
) {
  let time = now,
    key =
      options.key === undefined ? { apiKey: 'obviously-fake-api-key-for-unit-tests' } : options.key
  let config = normalizeAmbient({
    enabled: true,
    quietStart: options.quiet?.[0] ?? 0,
    quietEnd: options.quiet?.[1] ?? 0,
    yuanbao: { enabled: true, weatherEnabled: true, ...options.yuanbao },
  })
  let saved: YuanbaoCache | undefined,
    calls = 0,
    fail = options.fail ?? false,
    failureOnSave = options.failSave ?? false
  const years = new Set([2025, 2026])
  const requests: Record<string, unknown>[] = []
  const client: YuanbaoClient = new YuanbaoClient({
    now: () => time,
    transport: async (_url, init): Promise<Response> => {
      calls++
      assert.equal(
        saved!.requests,
        source.snapshot().requestsToday,
        'quota is durable before the transport sends',
      )
      const params = JSON.parse(String(init.body))
      requests.push(params)
      if (fail) throw Error('private transport details')
      if (String(params.Query).includes('天气'))
        return new Response(JSON.stringify(response('weather-m1')))
      if (String(params.Query).includes('金价'))
        return new Response(JSON.stringify(response('gold-m1')))
      if (String(params.Query).includes('股价'))
        return new Response(JSON.stringify(response('stock-m1')))
      const holiday = String(params.Query).includes('节假日安排')
      const pages = holiday
        ? [
            {
              title: '国务院办公厅关于2027年部分节假日安排的通知',
              passage: '国务院办公厅通知',
              site: '中国政府网',
              date: '2026-10-30',
              url: 'https://www.gov.cn/2027',
            },
          ]
        : [
            {
              title: `${params.Query} v2.4 发布`,
              passage: 'release 更新',
              site: '发布站',
              date: '2026-10-30',
              url: 'https://example.com/release',
            },
          ]
      return new Response(
        JSON.stringify({
          Response: { Version: 'standard', Pages: pages.map((page) => JSON.stringify(page)) },
        }),
      )
    },
  })
  const source: YuanbaoSource = new YuanbaoSource({
    config: () => config,
    credentials: () => key,
    client,
    now: () => time,
    cache: options.cache,
    holidays: () => ({}),
    hasYear: (year) => years.has(year),
    changed() {},
    save: (cache) => {
      if (failureOnSave) throw Error('disk unavailable')
      saved = structuredClone(cache)
    },
  })
  return {
    source,
    calls: () => calls,
    requests,
    saved: () => saved!,
    config: () => config,
    years,
    time: () => time,
    setTime: (value: number) => {
      time = value
    },
    setKey: (value: YuanbaoCredentials | null) => {
      key = value
      source.credentialsChanged()
    },
    fail: (value: boolean) => {
      fail = value
    },
    failSave: (value: boolean) => {
      failureOnSave = value
    },
    setConfig: (value: Partial<YuanbaoConfig>) => {
      config = normalizeAmbient({ ...config, yuanbao: { ...config.yuanbao, ...value } })
    },
  }
}

const holidays = {
  '2026-10-01': { name: '国庆', isOffDay: true },
  '2026-10-10': { name: '调休', isOffDay: false },
}
const cn = (clock: string, day = '2026-10-30') => Date.parse(`${day}T${clock}:00+08:00`)
test('A-share and HK trading boundaries distinguish lunch and their different closing times', () => {
  for (const [clock, expected] of [
    ['09:29', false],
    ['09:30', true],
    ['11:29', true],
    ['11:30', false],
    ['12:59', false],
    ['13:00', true],
    ['14:59', true],
    ['15:00', false],
  ] as const)
    assert.equal(quoteTradingTime('stock', '600519.sh', cn(clock), holidays), expected, clock)
  for (const [clock, expected] of [
    ['11:30', true],
    ['11:59', true],
    ['12:00', false],
    ['13:00', true],
    ['15:59', true],
    ['16:00', false],
  ] as const)
    assert.equal(quoteTradingTime('stock', '00700.hk', cn(clock), holidays), expected, clock)
})
test('gold night belongs to the prior trading day and excludes day/night breaks and 02:30', () => {
  for (const [clock, expected] of [
    ['08:59', false],
    ['09:00', true],
    ['15:29', true],
    ['15:30', false],
    ['19:59', false],
    ['20:00', true],
  ] as const)
    assert.equal(quoteTradingTime('gold', '', cn(clock), holidays), expected, clock)
  assert.equal(quoteTradingTime('gold', '', cn('01:00', '2026-10-31'), holidays), true)
  assert.equal(quoteTradingTime('gold', '', cn('02:30', '2026-10-31'), holidays), false)
  assert.equal(quoteTradingTime('gold', '', cn('01:00', '2026-11-02'), holidays), false)
})
test('official CN holidays and make-up weekends are not trading days; HK does not use CN holidays', () => {
  assert.equal(quoteTradingTime('stock', '600519.sh', cn('10:00', '2026-10-10'), holidays), false)
  assert.equal(quoteTradingTime('gold', '', cn('10:00', '2026-10-10'), holidays), false)
  assert.equal(quoteTradingTime('stock', '600519.sh', cn('10:00', '2026-10-01'), holidays), false)
  assert.equal(quoteTradingTime('stock', '00700.hk', cn('10:00', '2026-10-01'), holidays), true)
})
test('US trading uses New York DST, including both spring and autumn transitions', () => {
  for (const open of [
    '2026-03-06T14:30:00Z',
    '2026-03-09T13:30:00Z',
    '2026-10-30T13:30:00Z',
    '2026-11-02T14:30:00Z',
  ])
    assert.equal(quoteTradingTime('stock', 'aapl.us', Date.parse(open), {}), true, open)
  for (const closed of [
    '2026-03-06T13:30:00Z',
    '2026-03-09T12:30:00Z',
    '2026-11-02T13:30:00Z',
    '2026-11-02T21:00:00Z',
  ])
    assert.equal(quoteTradingTime('stock', 'aapl.us', Date.parse(closed), {}), false, closed)
})

for (const [name, options] of [
  ['no key', { key: null }],
  ['all feature switches off', { yuanbao: { weatherEnabled: false } }],
  ['master off', { yuanbao: { enabled: false } }],
  [
    'limit reached',
    { yuanbao: { dailyRequestLimit: 1 }, cache: { day: localDay(now), requests: 1 } },
  ],
  // Quiet hours are local time: derive the window from the runner's own clock, not UTC+8.
  ['quiet hours', { quiet: [localHour, (localHour + 1) % 24] }],
  [
    'outside A-share trading',
    { yuanbao: { weatherEnabled: false, stocksEnabled: true, stocks: ['600519.sh'] } },
  ],
  ['outside gold trading', { yuanbao: { weatherEnabled: false, goldEnabled: true } }],
] as const) {
  test(`Yuanbao scheduler sends nothing with ${name}`, async () => {
    const f = fixture(options as Parameters<typeof fixture>[0])
    await f.source.tick()
    assert.equal(f.calls(), 0)
  })
}
test('one persistent quota is shared across features and survives source recreation', async () => {
  const f = fixture({ yuanbao: { toolsEnabled: true, newsEnabled: true, dailyRequestLimit: 2 } })
  await f.source.tick()
  assert.equal(f.calls(), 2)
  assert.equal(f.source.snapshot().requestsToday, 2)
  assert.deepEqual(
    f.requests.map((request) => request.Mode),
    [1, 2],
  )
  const recreated = fixture({ cache: f.saved(), yuanbao: { dailyRequestLimit: 2 } })
  await recreated.source.tick()
  assert.equal(recreated.calls(), 0)
  assert.match((await f.source.test()).error, /上限/)
  assert.equal(f.calls(), 2)
})
test('failed calls consume reserved quota, do not retry and respect the next cadence', async () => {
  const f = fixture({ fail: true })
  await f.source.tick()
  await f.source.tick()
  assert.equal(f.calls(), 1)
  assert.equal(f.source.snapshot().requestsToday, 1)
  assert.equal(f.source.snapshot().errors.weather, '连接失败')
  assert.equal(f.source.snapshot().lastError, '')
  f.setTime(now + 7200000)
  await f.source.tick()
  assert.equal(f.calls(), 2)
  assert.equal(f.source.snapshot().requestsToday, 2)
})
test('testYuanbao bypasses flags and quiet hours but counts requests and refuses at the limit', async () => {
  const f = fixture({
    quiet: [0, 23],
    yuanbao: { enabled: false, weatherEnabled: false, dailyRequestLimit: 1 },
  })
  const result = await f.source.test()
  assert.equal(result.ok, true)
  assert.match(result.cardText, /今天 晴 4–22℃/)
  assert.equal(f.source.snapshot().requestsToday, 1)
  assert.equal((await f.source.test()).ok, false)
  assert.equal(f.calls(), 1)
  const noKey = fixture({ key: null })
  assert.equal((await noKey.source.test()).ok, false)
  assert.equal(noKey.calls(), 0)
})
test('a failed quota reservation never sends a paid request', async () => {
  const f = fixture({ failSave: true })
  assert.equal((await f.source.test()).ok, false)
  assert.equal(f.calls(), 0)
  assert.equal(f.source.snapshot().requestsToday, 0)
})
test('serialized concurrent test and scheduler calls cannot exceed the daily budget', async () => {
  const f = fixture({ yuanbao: { dailyRequestLimit: 1 } })
  const [first, second] = await Promise.all([f.source.test(), f.source.test(), f.source.tick()])
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(f.calls(), 1)
})
test('quota resets on the local date independently of display limits', async () => {
  const f = fixture({ yuanbao: { dailyRequestLimit: 1 } })
  await f.source.test()
  f.setTime(now + 86400000)
  assert.equal(f.source.snapshot().requestsToday, 0)
  await f.source.test()
  assert.equal(f.source.snapshot().requestsToday, 1)
  assert.equal(f.calls(), 2)
})
test('holiday watch spans October to January and stops when that year is synced', async () => {
  assert.equal(holidayWatchYear(cn('10:00', '2026-09-30')), null)
  assert.equal(holidayWatchYear(cn('10:00', '2026-10-01')), 2027)
  assert.equal(holidayWatchYear(cn('10:00', '2027-01-31')), 2027)
  assert.equal(holidayWatchYear(cn('10:00', '2027-02-01')), null)
  const f = fixture({ yuanbao: { weatherEnabled: false, holidayEnabled: true } })
  assert.deepEqual(f.source.snapshot().holiday, { year: 2027, state: 'pending' })
  await f.source.tick()
  assert.deepEqual(f.source.snapshot().holiday, { year: 2027, state: 'published' })
  await f.source.tick()
  assert.equal(f.calls(), 1)
  f.years.add(2027)
  assert.deepEqual(f.source.snapshot().holiday, { year: 2027, state: 'synced' })
  assert.equal(f.source.cards().length, 0)
  f.setTime(now + 86400000)
  await f.source.tick()
  assert.equal(f.calls(), 1)
  f.setTime(cn('10:00', '2027-02-01'))
  await f.source.tick()
  assert.equal(f.source.snapshot().holiday, null)
  assert.equal(f.calls(), 1)
})
test('quote cadence is one hour and suppresses repeat calls inside the same trading window', async () => {
  const f = fixture({
    yuanbao: {
      weatherEnabled: false,
      goldEnabled: true,
      stocksEnabled: true,
      stocks: ['00700.hk', '600519.sh'],
    },
  })
  f.setTime(cn('10:00'))
  await f.source.tick()
  assert.equal(f.calls(), 3)
  f.setTime(cn('10:59'))
  await f.source.tick()
  assert.equal(f.calls(), 3)
  f.setTime(cn('11:00'))
  await f.source.tick()
  assert.equal(f.calls(), 6)
})
test('gold brand presentation updates cached cards and their device identity without spending quota', async () => {
  const f = fixture({ yuanbao: { weatherEnabled: false, goldEnabled: true } })
  f.setTime(cn('20:00'))
  await f.source.tick()
  const withBrand = f.source.cards()[0]!
  assert.match(withBrand.text, /周大福/)
  f.setConfig({ goldBrand: false })
  const withoutBrand = f.source.cards()[0]!
  assert.doesNotMatch(withoutBrand.text, /周大福/)
  assert.notEqual(withoutBrand.id, withBrand.id)
  assert.equal(withoutBrand.publishedAt, withBrand.publishedAt)
  assert.equal(withoutBrand.expiresAt, withBrand.expiresAt)
  await f.source.tick()
  assert.equal(f.calls(), 1)
  f.setConfig({ goldBrand: true })
  assert.equal(f.source.cards()[0]!.id, withBrand.id)
})
test('queued obsolete symbols are skipped after settings change while a request is running', async () => {
  let config = normalizeAmbient({
    enabled: true,
    quietStart: 0,
    quietEnd: 0,
    yuanbao: { enabled: true, weatherEnabled: true, stocksEnabled: true, stocks: ['00700.hk'] },
  })
  const queries: string[] = []
  let release: () => void = () => {}
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const source = new YuanbaoSource({
    config: () => config,
    credentials: () => ({ apiKey: 'definitely-fake-api-key' }),
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    client: {
      search: async (params) => {
        queries.push(params.Query)
        await pause
        return { raw: response('weather-m1'), pages: [], latencyMs: 0, edition: 'standard' }
      },
    },
  })
  const pending = source.tick()
  for (let i = 0; i < 10 && !queries.length; i++) await Promise.resolve()
  config = normalizeAmbient({ ...config, yuanbao: { ...config.yuanbao, stocks: ['600519.sh'] } })
  release()
  await pending
  assert.equal(queries.length, 1)
  assert.equal(
    queries.some((query) => query.includes('00700.hk')),
    false,
  )
})
test('manual tests yield after the current background request instead of waiting for every feature', async () => {
  const config = normalizeAmbient({
    enabled: true,
    quietStart: 0,
    quietEnd: 0,
    yuanbao: { enabled: true, weatherEnabled: true, toolsEnabled: true, tools: ['Codex'] },
  })
  const queries: string[] = []
  let release: () => void = () => {}
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const source = new YuanbaoSource({
    config: () => config,
    credentials: () => ({ apiKey: 'definitely-fake-api-key' }),
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    client: {
      search: async (params) => {
        queries.push(params.Query)
        if (queries.length === 1) await pause
        return { raw: { Response: { Pages: [] } }, pages: [], latencyMs: 0, edition: 'standard' }
      },
    },
  })
  const pending = source.tick()
  for (let i = 0; i < 10 && !queries.length; i++) await Promise.resolve()
  const manual = source.test()
  release()
  await Promise.all([pending, manual])
  assert.equal(queries.length, 3)
  assert.ok(queries[0]!.includes('天气'))
  assert.ok(queries[1]!.includes('天气'))
  assert.ok(queries[2]!.includes('Codex'))
})
test('old X refresh and non-source settings cannot overwrite the independent Yuanbao cache', async () => {
  const key = { apiKey: 'obviously-fake-api-key-for-unit-tests' }
  const client = new YuanbaoClient({
    now: () => now,
    transport: async () => new Response(JSON.stringify(response('weather-m1'))),
  })
  const config = normalizeAmbient({
    enabled: true,
    xEnabled: false,
    memeEnabled: false,
    newsEnabled: false,
    conceptsEnabled: false,
    petEnabled: false,
    calendarEnabled: false,
    quietStart: 0,
    quietEnd: 0,
    yuanbao: { enabled: true, weatherEnabled: true },
  })
  const service = new AmbientService({
    config,
    now: () => now,
    status: () => new StatusHub().snapshot(),
    key: () => '',
    save() {},
    changed() {},
    request: async () => ({}),
    image: async () => '',
    yuanbaoKey: () => key,
    yuanbaoClient: client,
  })
  await service.yuanbao.tick()
  const cards = service.snapshot().cards.filter((card) => card.kind === 'life')
  assert.equal(cards.length, 1)
  await service.refresh(true)
  service.configure({
    ...service.getConfig(),
    gapMinutes: 45,
    yuanbao: { ...config.yuanbao, dailyRequestLimit: 50 },
  })
  assert.deepEqual(
    service.snapshot().cards.filter((card) => card.kind === 'life'),
    cards,
  )
  assert.equal(qualifies(cards[0]!, service.getConfig(), now), true)
  const newer = { ...cards[0]!, id: cards[0]!.id + ':new' }
  assert.notEqual(
    contentKey(newer),
    contentKey(cards[0]!),
    'equal text with a fresh data identity is not blocked by old content history',
  )
  assert.equal(qualifies({ ...cards[0]!, score: 0 }, service.getConfig(), now), false)
})
test('cards cached before the life layout are refreshed once after an upgrade, never on every start', async () => {
  const first = fixture()
  await first.source.tick()
  assert.equal(first.calls(), 1)
  const current = first.saved()
  assert.equal(current.layoutVersion, 1)
  assert.equal(current.entries[0]!.card.layout, 'life')
  const { layoutVersion: _drop, ...legacy } = structuredClone(current)
  legacy.entries = legacy.entries.map(({ key, card }) => {
    const { layout: _layout, life: _life, ...text } = card
    return { key, card: text }
  })
  // An upgraded cache: text-only cards and no layoutVersion. The topic becomes due once.
  const upgraded = fixture({ cache: legacy })
  await upgraded.source.tick()
  assert.equal(upgraded.calls(), 1)
  assert.equal(upgraded.saved().entries[0]!.card.layout, 'life')
  // Already migrated: a text-only card (e.g. a validation fallback) does not refetch.
  const migrated = fixture({ cache: { ...legacy, layoutVersion: 1 } })
  await migrated.source.tick()
  assert.equal(migrated.calls(), 0)
  // A pre-1.5 cache whose cards already carry life keeps its schedule.
  const { layoutVersion: _v, ...withLife } = structuredClone(current)
  const kept = fixture({ cache: withLife })
  await kept.source.tick()
  assert.equal(kept.calls(), 0)
})

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  DEFAULT_AMBIENT,
  normalizeAmbient,
  type AmbientCard,
  type CalendarNextHoliday,
  type StatusSnapshot,
} from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import {
  HolidayStore,
  calendarCard,
  holidayUrl,
  holidayYears,
  mergeHolidays,
  nextHoliday,
  parseRemoteYear,
  type HolidayCache,
} from '../apps/desktop/src/main/ambient-calendar.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import {
  contentKey,
  deviceCard,
  qualifies,
  withAmbient,
} from '../apps/desktop/src/main/ambient-rules.js'
import { BUILTIN_HOLIDAYS, parseHolidayCn } from '../apps/desktop/src/main/calendar/index.js'

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime()
const noon = at(2026, 10, 30)
const idle = { overall: 'idle', updatedAt: noon, agents: [] } as unknown as StatusSnapshot
const working = {
  overall: 'running',
  updatedAt: noon,
  agents: [
    {
      agentType: 'codex',
      state: 'THINKING',
      unread: false,
      needPermission: false,
      needUserInput: false,
      toolCallCount: 0,
      lastEventAt: 0,
    },
  ],
} as unknown as StatusSnapshot
const config = (overrides = {}) =>
  normalizeAmbient({
    ...DEFAULT_AMBIENT,
    enabled: true,
    xEnabled: false,
    memeEnabled: false,
    conceptsEnabled: false,
    petEnabled: false,
    quietStart: 0,
    quietEnd: 0,
    ...overrides,
  })
const cn = (year: number, days: { name: string; date: string; isOffDay: boolean }[]) => ({
  year,
  days,
})
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

function calendarService(
  options: {
    overrides?: object
    cache?: unknown
    status?: StatusSnapshot
    respond?: (url: string) => unknown
    start?: number
  } = {},
) {
  let now = options.start ?? noon,
    current = options.status ?? idle,
    changes = 0
  const requests: string[] = [],
    saved: HolidayCache[] = []
  const service = new AmbientService({
    config: config(options.overrides),
    now: () => now,
    status: () => current,
    key: () => '',
    save: () => undefined,
    changed: () => {
      changes++
    },
    request: async (url) => {
      requests.push(url)
      if (!options.respond) throw new Error('offline')
      return options.respond(url)
    },
    image: async () => '',
    holidayCache: options.cache,
    saveHolidayCache: (cache) => {
      saved.push(structuredClone(cache))
    },
  })
  return {
    service,
    requests,
    saved,
    changes: () => changes,
    advance: (ms: number) => {
      now += ms
    },
    set: (s: StatusSnapshot) => {
      current = s
    },
    calendar: () => service.snapshot().cards.find((c) => c.kind === 'calendar')!,
  }
}

test('settings: the calendar is on by default, junk and legacy settings keep it on', () => {
  assert.equal(DEFAULT_AMBIENT.calendarEnabled, true)
  assert.equal(normalizeAmbient(null).calendarEnabled, true)
  assert.equal(normalizeAmbient({}).calendarEnabled, true)
  const legacy = { ...DEFAULT_AMBIENT } as Record<string, unknown>
  delete legacy.calendarEnabled
  assert.equal(normalizeAmbient(legacy).calendarEnabled, true)
  assert.equal(normalizeAmbient({ calendarEnabled: false }).calendarEnabled, false)
  for (const bad of ['no', 0, null, [false]])
    assert.equal(normalizeAmbient({ calendarEnabled: bad }).calendarEnabled, true)
})

test('card: one calendar per local day, valid for that day only', () => {
  const card = calendarCard(noon)
  assert.equal(card.id, 'calendar:2026-10-30')
  assert.equal(card.kind, 'calendar')
  assert.equal(card.layout, 'calendar')
  assert.equal(card.source, '日历')
  assert.equal(card.text, '10月30日 周五 · 农历九月廿一 · 第44周')
  assert.equal(card.url, '')
  assert.equal(card.imageHex, undefined)
  assert.equal(card.calendar?.today, 30)
  assert.equal(card.publishedAt, at(2026, 10, 30, 0))
  assert.equal(card.expiresAt, at(2026, 10, 31, 0))
  assert.equal(calendarCard(at(2026, 10, 31, 0)).id, 'calendar:2026-10-31')
  assert.equal(calendarCard(at(2026, 12, 31, 23)).expiresAt, at(2027, 1, 1, 0))
})

test('projection: the device gets layout and calendar, no bitmap, and an id that follows the content', () => {
  const card = calendarCard(noon)
  const device = deviceCard(card)
  assert.equal(device.layout, 'calendar')
  assert.deepEqual(device.calendar, card.calendar)
  assert.equal(device.source, '日历')
  assert.equal(device.text, card.text)
  assert.equal('imageHex' in device, false)
  assert.equal('red' in device, false)
  assert.match(device.id, /^[0-9a-f]{24}$/)
  assert.equal(deviceCard(calendarCard(noon + 3600000)).id, device.id, 'same content, same id')
  assert.notEqual(deviceCard(calendarCard(at(2026, 10, 31))).id, device.id, 'tomorrow is new')
  // A holiday update that changes the grid is a new id, even on the same day.
  const changed = calendarCard(
    noon,
    parseHolidayCn(cn(2026, [{ name: '测试', date: '2026-10-30', isOffDay: true }])),
  )
  assert.notEqual(deviceCard(changed).id, device.id)
  assert.notEqual(contentKey(changed), contentKey(card))
  // A calendar missing from the card is a plain text card with the plain id.
  const plain: AmbientCard = { ...card, calendar: undefined, layout: undefined }
  const plainDevice = deviceCard(plain)
  assert.equal('layout' in plainDevice, false)
  assert.equal('calendar' in plainDevice, false)
  assert.equal(plainDevice.id, createHash('sha256').update(card.id).digest('hex').slice(0, 24))
  // Pet and image ids are untouched by the new branch.
  const image: AmbientCard = {
    ...card,
    kind: 'image',
    calendar: undefined,
    layout: undefined,
    imageHex: '00',
  }
  assert.equal(
    deviceCard(image).id,
    createHash('sha256')
      .update(card.id + '\u0000\u0000' + '00' + '\u0000')
      .digest('hex')
      .slice(0, 24),
  )
})

test('projection: the calendar is part of the revision and of the status size guard', () => {
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  const card = calendarCard(noon)
  const full = withAmbient(base, card)
  assert.equal(full.ambient?.layout, 'calendar')
  assert.deepEqual(full.ambient?.calendar, card.calendar)
  assert.notEqual(full.revision, base.revision)
  assert.notEqual(
    full.revision,
    withAmbient(
      base,
      calendarCard(
        noon,
        parseHolidayCn(cn(2026, [{ name: 'x', date: '2026-10-30', isOffDay: true }])),
      ),
    ).revision,
    'a different grid is a different revision',
  )
  assert.ok(size(full) <= 32000)
  // Order of dropping: the whole grid goes first and the text card stays, under a new id.
  const textOnly = withAmbient(base, { ...card, calendar: undefined, layout: undefined })
  const extra = size(full) - size(textOnly)
  assert.ok(extra > 400 && extra < 4000, 'the grid is about a kilobyte, got ' + extra)
  const tight = { ...base, message: 'x'.repeat(32000 - size(textOnly) - 10) }
  const reduced = withAmbient(tight, card)
  assert.equal(reduced.ambient?.text, card.text)
  assert.equal(reduced.ambient?.calendar, undefined)
  assert.equal(reduced.ambient?.layout, undefined)
  assert.notEqual(reduced.ambient?.id, full.ambient?.id, 'a different picture needs a different id')
  assert.ok(size(reduced) <= 32000)
  // Not even the text fits: plain work status.
  const crowded = { ...base, message: 'x'.repeat(31990) }
  assert.equal(withAmbient(crowded, card), crowded)
})

test('rules: the calendar follows its setting, and expires with the day', () => {
  const card = calendarCard(noon)
  assert.equal(qualifies(card, config(), noon), true)
  assert.equal(qualifies(card, config({ calendarEnabled: false }), noon), false)
  assert.equal(qualifies(card, config(), at(2026, 10, 31, 0)), false)
})

test('service: the calendar is pushed once a day within the usual pacing', () => {
  const f = calendarService()
  f.service.show()
  const shown = f.service.current()!
  assert.equal(shown.id, 'calendar:2026-10-30')
  assert.equal(shown.layout, 'calendar')
  assert.equal(f.service.snapshot().shownToday, 1)
  f.service.dismiss()
  f.advance(3 * 3600000)
  f.service.show()
  assert.equal(f.service.current(), undefined, 'already shown today')
  f.advance(24 * 3600000)
  f.service.show()
  assert.equal(f.service.current()?.id, 'calendar:2026-10-31')
})

test('service: the calendar waits for Agents and quiet hours like everything else', () => {
  const busy = calendarService({ status: working })
  busy.service.show()
  assert.equal(busy.service.current(), undefined, 'an Agent is working')
  const night = calendarService({ overrides: { quietStart: 12, quietEnd: 13 } })
  night.service.show()
  assert.equal(night.service.current(), undefined, 'quiet hours')
})

test('service: a switched-off calendar is never pushed or fetched, but can be shown by hand', async () => {
  const f = calendarService({ overrides: { calendarEnabled: false }, respond: () => ({}) })
  f.service.tick()
  await flush()
  assert.equal(f.service.current(), undefined)
  assert.deepEqual(f.requests, [])
  f.service.showManual('calendar:2026-10-30')
  assert.equal(f.service.current()?.manual, true)
  assert.equal(f.service.current()?.kind, 'calendar')
  // A page opened yesterday still reaches today's card.
  f.advance(24 * 3600000)
  assert.equal(f.service.resolveCard('calendar:2026-10-30')?.id, 'calendar:2026-10-31')
  assert.equal(f.service.resolveCard('calendar:garbage')?.kind, 'calendar')
})

test('service: a clock outside the supported years leaves the page working', () => {
  const f = calendarService({ start: new Date(2300, 0, 1, 12).getTime() })
  assert.equal(
    f.service.snapshot().cards.some((c) => c.kind === 'calendar'),
    false,
  )
  assert.equal(f.service.snapshot().calendarNext, undefined)
})

test('holidays: remote years replace the same built-in year as a whole and add new years', () => {
  const remote = parseHolidayCn(
    cn(2026, [{ name: '测试假日', date: '2026-10-30', isOffDay: true }]),
  )
  const next = parseHolidayCn(cn(2027, [{ name: '元旦', date: '2027-01-01', isOffDay: true }]))
  const merged = mergeHolidays(BUILTIN_HOLIDAYS, { 2026: remote, 2027: next })
  assert.equal(merged['2026-10-30']?.name, '测试假日')
  assert.equal(merged['2026-10-01'], undefined, 'the rest of 2026 is the remote version')
  assert.equal(merged['2025-10-01']?.isOffDay, true, 'other built-in years stay')
  assert.equal(merged['2027-01-01']?.name, '元旦')
  assert.deepEqual(mergeHolidays(BUILTIN_HOLIDAYS, {}), BUILTIN_HOLIDAYS)
})

test('holidays: only a valid, non-empty file for the requested year is accepted', () => {
  const good = cn(2026, [{ name: '国庆节', date: '2026-10-01', isOffDay: true }])
  assert.ok(parseRemoteYear(2026, good))
  assert.ok(parseRemoteYear(2026, { ...good, $schema: 'x', papers: [] }), 'extra keys are fine')
  assert.equal(parseRemoteYear(2027, good), undefined, 'wrong year')
  assert.equal(parseRemoteYear(2026, cn(2026, [])), undefined, 'empty days')
  for (const bad of [
    null,
    'text',
    42,
    {},
    { year: 2026 },
    cn(2026, [{ name: '', date: '2026-10-01', isOffDay: true }]),
    cn(2026, [{ name: 'x', date: '2026-02-30', isOffDay: true }]),
    cn(2026, [{ name: 'x', date: '2026-10-01', isOffDay: 1 as unknown as boolean }]),
    cn(2026, [
      { name: 'x', date: '2026-10-01', isOffDay: true },
      { name: 'x', date: '2026-10-01', isOffDay: false },
    ]),
  ])
    assert.equal(parseRemoteYear(2026, bad), undefined)
})

test('holidays: this year is fetched, next year only from November', () => {
  assert.deepEqual(holidayYears(at(2026, 10, 31)), [2026])
  assert.deepEqual(holidayYears(at(2026, 11, 1, 0)), [2026, 2027])
  assert.deepEqual(holidayYears(at(2026, 12, 31)), [2026, 2027])
  assert.equal(
    holidayUrl(2027),
    'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2027.json',
  )
})

test('holidays: the service fetches once per year per day, merges and caches the result', async () => {
  const remote = cn(2026, [
    { name: '测试假日', date: '2026-10-30', isOffDay: true },
    { name: '测试假日', date: '2026-10-31', isOffDay: false },
  ])
  const f = calendarService({ respond: () => remote })
  assert.equal(f.calendar().calendar?.flags[0]! & 4, 4, 'built-in National Day before the fetch')
  assert.equal(f.service.snapshot().calendarNext, undefined)
  f.service.tick()
  f.service.tick() // The 15 second ticker must not refetch.
  await flush()
  assert.deepEqual(f.requests, [holidayUrl(2026)])
  const calendar = f.calendar().calendar!
  assert.equal(calendar.flags[29]! & 4, 4, 'the remote day off')
  assert.equal(calendar.flags[30]! & 8, 8, 'the remote make-up day')
  assert.equal(calendar.flags[0]! & 4, 0, 'the remote 2026 replaces the built-in 2026')
  assert.deepEqual(f.service.snapshot().calendarNext, {
    name: '测试假日',
    date: '2026-10-30',
    inDays: 0,
    ongoing: true,
  })
  assert.ok(f.changes() > 0, 'the page is told about new data')
  const cache = f.saved.at(-1)!
  assert.equal(cache.version, 1)
  assert.deepEqual(Object.keys(cache.years), ['2026'])
  assert.deepEqual(cache.years['2026']!.days.length, 2)
  assert.equal(cache.attempts['2026'], '2026-10-30')
  // The next day it is tried again; in November next year joins.
  f.advance(24 * 3600000)
  f.service.tick()
  await flush()
  assert.deepEqual(f.requests, [holidayUrl(2026), holidayUrl(2026)])
  f.advance(2 * 24 * 3600000)
  f.service.tick()
  await flush()
  assert.deepEqual(f.requests.slice(2), [holidayUrl(2026), holidayUrl(2027)])
})

test("holidays: failures are silent, still count as the day's attempt, and keep the built-in table", async () => {
  const bad: unknown[] = [
    cn(2026, []),
    cn(2025, [{ name: 'x', date: '2025-01-01', isOffDay: true }]),
    'not an object',
    undefined,
  ]
  for (const body of bad) {
    const f = calendarService({ respond: () => body })
    const before = JSON.stringify(f.calendar().calendar)
    f.service.tick()
    await flush()
    assert.equal(JSON.stringify(f.calendar().calendar), before)
    assert.equal(f.saved.at(-1)?.attempts['2026'], '2026-10-30')
    assert.deepEqual(f.saved.at(-1)?.years, {})
    f.service.tick()
    await flush()
    assert.equal(f.requests.length, 1, 'one attempt per day')
  }
  const offline = calendarService() // The request rejects.
  offline.service.tick()
  await flush()
  assert.equal(offline.requests.length, 1)
  assert.ok(offline.calendar().calendar!.flags[0]! & 4, 'built-in National Day')
  const thrown = calendarService({
    respond: () => {
      throw new Error('boom')
    },
  })
  thrown.service.tick()
  await flush()
  assert.equal(thrown.requests.length, 1)
})

test('holidays: the cache is used offline, validated on load and pruned by year', async () => {
  const good = cn(2026, [{ name: '测试假日', date: '2026-10-30', isOffDay: true }])
  const old = cn(2025, [{ name: '旧', date: '2025-01-01', isOffDay: true }])
  const cached = {
    version: 1,
    years: { 2026: good, 2025: old, 2027: cn(2027, []), junk: good, 2024: 'nope' },
    attempts: { 2026: '2026-10-29', bad: '2026-10-29', 2025: 'yesterday' },
  }
  const f = calendarService({ cache: cached })
  assert.equal(f.calendar().calendar?.flags[29]! & 4, 4, 'cached remote day, no network yet')
  assert.equal(f.calendar().calendar?.flags[0]! & 4, 0)
  f.service.tick() // attempts['2026'] is yesterday, so one fetch which fails
  await flush()
  assert.equal(f.requests.length, 1)
  assert.equal(f.calendar().calendar?.flags[29]! & 4, 4, 'a failed refresh keeps the cache')
  const saved = f.saved.at(-1)!
  assert.deepEqual(Object.keys(saved.years), ['2026'], 'invalid and past years are dropped')
  assert.deepEqual(Object.keys(saved.attempts), ['2026'])
  // Junk caches are the same as no cache.
  for (const junk of [
    undefined,
    null,
    'x',
    7,
    [],
    { years: 5, attempts: 5 },
    { years: { 2026: 7 } },
  ]) {
    const store = new HolidayStore(junk)
    assert.deepEqual(store.table(), BUILTIN_HOLIDAYS)
  }
  // A throwing cache writer never reaches the service.
  const stubborn = new HolidayStore(undefined, () => {
    throw new Error('disk full')
  })
  assert.equal(await stubborn.sync(noon, async () => good), true)
  assert.equal(stubborn.table()['2026-10-30']?.name, '测试假日')
})

test('holidays: a stopped service ignores a late answer', async () => {
  let release: (value: unknown) => void = () => undefined
  const f = calendarService({
    respond: () => new Promise((resolve) => (release = resolve)),
  })
  f.service.tick()
  const before = f.changes()
  f.service.stop()
  release(cn(2026, [{ name: '测试假日', date: '2026-10-30', isOffDay: true }]))
  await flush()
  assert.equal(f.changes(), before)
})

test('next holiday: the break going on, or the first day off of the next one', () => {
  const next = (y: number, m: number, d: number): CalendarNextHoliday | undefined =>
    nextHoliday(at(y, m, d), BUILTIN_HOLIDAYS)
  // The weekend before the break is not the holiday; the make-up Sunday is a workday.
  assert.deepEqual(next(2026, 9, 20), {
    name: '中秋节',
    date: '2026-09-25',
    inDays: 5,
    ongoing: false,
  })
  assert.deepEqual(next(2026, 10, 1), {
    name: '国庆节',
    date: '2026-10-01',
    inDays: 0,
    ongoing: true,
  })
  assert.equal(next(2026, 10, 7)?.ongoing, true, 'the last day is still the break')
  assert.equal(next(2026, 10, 8), undefined, 'nothing known after 2026')
  assert.deepEqual(next(2025, 12, 20), {
    name: '元旦',
    date: '2026-01-01',
    inDays: 12,
    ongoing: false,
  })
  assert.equal(next(2026, 1, 3)?.ongoing, true)
  assert.deepEqual(
    next(2026, 1, 4),
    {
      name: '春节',
      date: '2026-02-15',
      inDays: 42,
      ongoing: false,
    },
    'a make-up workday is not a day off',
  )
  assert.equal(next(2026, 10, 30), undefined)
  // The merged name for a shared break is kept as published.
  assert.equal(next(2025, 9, 30)?.name, '国庆节、中秋节')
})

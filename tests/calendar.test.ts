import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import {
  BUILTIN_HOLIDAYS,
  buildMonthCalendar,
  calendarCardFields,
  isoWeek,
  lunarDate,
  parseHolidayCn,
  solarTerm,
} from '../apps/desktop/src/main/calendar/index.js'

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12)
function cell(y: number, m: number, d: number, holidays = BUILTIN_HOLIDAYS) {
  const calendar = buildMonthCalendar(at(y, m, d), holidays)
  return { label: calendar.labels[d - 1], flags: calendar.flags[d - 1] }
}

test('calendar: month geometry and ISO week-year boundaries', () => {
  const october = buildMonthCalendar(at(2026, 10, 30))
  assert.deepEqual(
    [
      october.year,
      october.month,
      october.today,
      october.first,
      october.days,
      october.lunar,
      october.week,
    ],
    [2026, 10, 30, 3, 31, '丙午年 九月廿一', 44],
  )
  assert.equal(buildMonthCalendar(at(2024, 2, 29)).days, 29)
  assert.equal(buildMonthCalendar(at(1900, 2, 1)).days, 28)
  assert.equal(buildMonthCalendar(at(2000, 2, 1)).days, 29)
  assert.equal(buildMonthCalendar(at(2100, 2, 1)).days, 28)
  assert.equal(buildMonthCalendar(at(2026, 6, 1)).first, 0)
  assert.equal(buildMonthCalendar(at(2026, 2, 1)).first, 6)
  for (const [y, m, d, week] of [
    [2021, 1, 1, 53],
    [2021, 1, 3, 53],
    [2021, 1, 4, 1],
    [2018, 12, 31, 1],
    [2020, 12, 31, 53],
    [2026, 10, 30, 44],
    [2027, 1, 1, 53],
    [1900, 1, 1, 1],
  ])
    assert.equal(isoWeek(at(y!, m!, d!)), week)
})

test('calendar: all requested festivals, Qingming and lunar month/day names', () => {
  for (const [m, d, name] of [
    [1, 1, '元旦'],
    [3, 8, '妇女节'],
    [3, 12, '植树节'],
    [5, 1, '劳动节'],
    [5, 4, '青年节'],
    [6, 1, '儿童节'],
    [7, 1, '建党节'],
    [8, 1, '建军节'],
    [9, 10, '教师节'],
    [10, 1, '国庆节'],
  ] as const) {
    const result = cell(2026, m, d)
    assert.equal(result.label, name)
    assert.ok(result.flags! & 2)
  }
  for (const [y, m, d, name] of [
    [2025, 1, 28, '除夕'],
    [2025, 1, 29, '春节'],
    [2025, 2, 12, '元宵节'],
    [2025, 3, 1, '龙抬头'],
    [2025, 5, 31, '端午节'],
    [2025, 8, 29, '七夕'],
    [2025, 9, 6, '中元节'],
    [2025, 10, 6, '中秋节'],
    [2025, 10, 29, '重阳节'],
    [2025, 1, 7, '腊八节'],
    [2025, 1, 22, '小年'],
    [2024, 2, 9, '除夕'],
    [2026, 2, 17, '春节'],
    [2025, 1, 5, '小寒'],
    [2025, 4, 4, '清明'],
    [2026, 4, 5, '清明'],
    [2020, 10, 1, '中秋节'], // Lunar festival wins over Gregorian National Day.
    [2025, 5, 5, '立夏'], // May Day's holiday name never takes over the other days.
  ] as const) {
    const result = cell(y, m, d)
    assert.equal(result.label, name, `${y}-${m}-${d}`)
    assert.ok(result.flags! & 2)
  }
  assert.equal(cell(2025, 7, 25).label, '闰六月')
  assert.equal(cell(2023, 3, 23).label, '初二', 'Leap second month does not repeat 龙抬头')
  assert.equal(cell(2025, 2, 2).label, '初五', 'An off day does not repeat 春节')
  assert.equal(cell(2026, 1, 19).label, '腊月')
  assert.equal(cell(2026, 10, 30).label, '廿一')
  assert.equal(cell(2025, 7, 27).label, '初三')
})

test('calendar: weekends, official holidays and makeup workdays have independent number/label flags', () => {
  assert.equal(cell(2026, 10, 24).flags, 1)
  assert.equal(cell(2026, 10, 25).flags, 1)
  assert.equal(cell(2026, 10, 26).flags, 0)
  assert.deepEqual(cell(2025, 1, 26), { label: '廿七', flags: 8 })
  assert.deepEqual(cell(2025, 2, 8), { label: '十一', flags: 8 })
  assert.deepEqual(cell(2026, 1, 4), { label: '十六', flags: 8 })
  assert.deepEqual(cell(2026, 10, 10), { label: '九月', flags: 8 })
  assert.deepEqual(cell(2026, 10, 1), { label: '国庆节', flags: 7 })
  assert.equal(cell(2026, 10, 2).flags, 5)
  assert.deepEqual(cell(2025, 4, 4), { label: '清明', flags: 7 })
  assert.deepEqual(cell(2026, 3, 12), { label: '植树节', flags: 2 })
  assert.equal(cell(2027, 2, 6).flags, 3, 'No inferred statutory vacation outside announced years')
  const custom = parseHolidayCn({
    year: 2026,
    days: [
      { name: '名称不作标签', date: '2026-10-01', isOffDay: false },
      { name: '额外假期', date: '2026-10-30', isOffDay: true },
    ],
  })
  assert.deepEqual(cell(2026, 10, 1, custom), { label: '国庆节', flags: 10 })
  assert.deepEqual(cell(2026, 10, 30, custom), { label: '廿一', flags: 5 })
  assert.equal(cell(2026, 10, 2, custom).flags, 0, 'Supplied table replaces the defaults')
})

test('calendar: every month in 1900–2100 satisfies the device contract', () => {
  for (let year = 1900; year <= 2100; year++)
    for (let month = 1; month <= 12; month++) {
      const now = at(year, month, 15)
      const calendar = buildMonthCalendar(now)
      const days = new Date(Date.UTC(year, month, 0)).getUTCDate()
      assert.equal(calendar.year, year)
      assert.equal(calendar.month, month)
      assert.equal(calendar.today, 15)
      assert.equal(calendar.days, days)
      assert.ok(calendar.first >= 0 && calendar.first <= 6)
      assert.ok(calendar.week >= 1 && calendar.week <= 53)
      assert.ok(Buffer.byteLength(calendar.lunar, 'utf8') <= 32)
      assert.equal(calendar.labels.length, days)
      assert.equal(calendar.flags.length, days)
      calendar.labels.forEach((label) => assert.match(label, /^[\p{Script=Han}]{1,4}$/u))
      calendar.flags.forEach((flags) => {
        assert.ok(Number.isInteger(flags) && flags >= 0 && flags <= 15)
        assert.notEqual(flags & 12, 12, '休 and 班 are mutually exclusive')
        if (flags & 4) assert.ok(flags & 1)
        if (flags & 8) assert.equal(flags & 1, 0)
      })
    }
})

test('calendar: card fields and fresh month arrays are deterministic for a local day', () => {
  const now = new Date(2026, 9, 30)
  const before = now.getTime()
  const card = calendarCardFields(now)
  assert.equal(card.id, 'calendar:2026-10-30')
  assert.equal(card.source, '日历')
  assert.equal(card.text, '10月30日 周五 · 农历九月廿一 · 第44周')
  assert.deepEqual(Object.keys(card).sort(), ['calendar', 'id', 'source', 'text'])
  assert.deepEqual(card, calendarCardFields(new Date(2026, 9, 30, 23, 59, 59)))
  assert.notEqual(card.id, calendarCardFields(new Date(2026, 9, 31)).id)
  assert.deepEqual(card.calendar, buildMonthCalendar(now))
  card.calendar.labels[0] = 'changed'
  card.calendar.flags[0] = 15
  assert.equal(buildMonthCalendar(now).labels[0], '国庆节')
  assert.equal(buildMonthCalendar(now).flags[0], 7)
  assert.equal(now.getTime(), before)
  assert.equal(buildMonthCalendar(at(2025, 7, 27)).lunar, '乙巳年 闰六月初三')
})

test('calendar: invalid Dates and unsupported Gregorian years fail explicitly', () => {
  for (const invalid of [new Date(NaN), at(1899, 12, 31), at(2101, 1, 1)])
    for (const fn of [lunarDate, solarTerm, isoWeek, buildMonthCalendar, calendarCardFields])
      assert.throws(() => fn(invalid), RangeError)
})

test('calendar: local date fields survive UTC boundaries and DST in separate timezone processes', () => {
  const root = resolve('.tmpshots')
  mkdirSync(root, { recursive: true })
  const dir = mkdtempSync(join(root, 'calendar-tz-'))
  try {
    const { buildSync } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild')
    const file = join(dir, 'calendar.mjs')
    const result = buildSync({
      entryPoints: ['apps/desktop/src/main/calendar/index.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
    })
    writeFileSync(file, result.outputFiles[0]!.text)
    const script = `import { buildMonthCalendar, calendarCardFields, isoWeek, lunarDate, solarTerm } from './calendar.mjs';
      const dates = [new Date(2026,9,30,0,1), new Date(2025,0,5,23,59), new Date(2026,2,8,0,1), new Date(2026,10,1,23,59)];
      console.log(JSON.stringify(dates.map(d => ({ card: calendarCardFields(d), week: isoWeek(d), lunar: lunarDate(d), term: solarTerm(d) }))));`
    writeFileSync(join(dir, 'check.mjs'), script)
    const outputs = ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Pacific/Kiritimati'].map(
      (TZ) => {
        const child = spawnSync(process.execPath, ['check.mjs'], {
          cwd: dir,
          encoding: 'utf8',
          env: { ...process.env, TZ },
        })
        assert.equal(child.status, 0, child.stderr)
        return child.stdout.trim()
      },
    )
    outputs.forEach((output) => assert.equal(output, outputs[0]))
  } finally {
    assert.equal(dirname(resolve(dir)), root)
    rmSync(dir, { recursive: true, force: true })
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { lunarDate, solarTerm } from '../apps/desktop/src/main/calendar/index.js'

const DAY = 86400000
const at = (year: number, month: number, day: number) => new Date(year, month - 1, day, 12)
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`)
type MonthStart = readonly [date: string, year: number, month: number, isLeap: boolean]

// Independent literal HKO month starts, not decoded from the production table.
// Source for each Gregorian year: https://www.hko.gov.hk/tc/gts/time/calendar/text/files/T{year}c.txt
// Each interval documents a known ICU disagreement; all its days still get checked.
const HKO_DIFFERENCES: readonly {
  from: string
  to: string
  starts: readonly MonthStart[]
}[] = [
  {
    from: '1917-03-23',
    to: '1917-05-20',
    starts: [
      ['1917-03-23', 1917, 2, true],
      ['1917-04-21', 1917, 3, false],
    ],
  },
  {
    from: '1922-06-25',
    to: '1922-08-22',
    starts: [
      ['1922-06-25', 1922, 5, true],
      ['1922-07-24', 1922, 6, false],
    ],
  },
  { from: '1954-02-03', to: '1954-03-04', starts: [['1954-02-03', 1954, 1, false]] },
  { from: '1955-02-22', to: '1955-03-23', starts: [['1955-02-22', 1955, 2, false]] },
  {
    from: '1987-07-26',
    to: '1987-09-22',
    starts: [
      ['1987-07-26', 1987, 6, true],
      ['1987-08-24', 1987, 7, false],
    ],
  },
  { from: '1999-01-17', to: '1999-02-15', starts: [['1999-01-17', 1998, 12, false]] },
  { from: '2012-08-17', to: '2012-09-15', starts: [['2012-08-17', 2012, 7, false]] },
  {
    from: '2018-11-07',
    to: '2018-12-06',
    starts: [
      ['2018-10-09', 2018, 9, false],
      ['2018-11-08', 2018, 10, false],
    ],
  },
  { from: '2027-02-06', to: '2027-03-07', starts: [['2027-02-06', 2027, 1, false]] },
  {
    from: '2030-02-02',
    to: '2030-03-03',
    starts: [
      ['2030-01-04', 2029, 12, false],
      ['2030-02-03', 2030, 1, false],
    ],
  },
  { from: '2057-09-28', to: '2057-10-27', starts: [['2057-09-28', 2057, 9, false]] },
  { from: '2070-03-12', to: '2070-04-10', starts: [['2070-03-12', 2070, 2, false]] },
]

test('calendar lunar: every Gregorian day in 1900–2100 is cross-checked against Intl and explicit HKO resolutions', (t) => {
  const formatter = new Intl.DateTimeFormat('en-u-ca-chinese', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  })
  assert.equal(formatter.resolvedOptions().calendar, 'chinese')
  const differences = HKO_DIFFERENCES.map(({ from, to, starts }) => ({
    from: utc(from),
    to: utc(to),
    starts: starts.map(([date, year, month, isLeap]) => ({ time: utc(date), year, month, isLeap })),
  }))
  let count = 0,
    disagreements = 0,
    resolvedDays = 0
  for (let time = Date.UTC(1900, 0, 1); time < Date.UTC(2101, 0, 1); time += DAY) {
    const d = new Date(time)
    const actual = lunarDate(at(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()))
    const observed = [actual.year, actual.month, actual.day, actual.isLeapMonth]
    const parts = Object.fromEntries(formatter.formatToParts(d).map((p) => [p.type, p.value]))
    const independent = [
      Number(parts.relatedYear),
      parseInt(parts.month!),
      Number(parts.day),
      parts.month!.endsWith('bis'),
    ]
    const difference = differences.find((r) => time >= r.from && time <= r.to)
    const key = d.toISOString().slice(0, 10)
    if (difference) {
      const start = difference.starts.findLast((s) => s.time <= time)!
      assert.deepEqual(
        observed,
        [start.year, start.month, (time - start.time) / DAY + 1, start.isLeap],
        `HKO ${key}`,
      )
      resolvedDays++
    } else assert.deepEqual(observed, independent, `Intl ${key}`)
    if (JSON.stringify(observed) !== JSON.stringify(independent)) {
      assert.ok(difference, `Unexplained ICU difference ${key}`)
      disagreements++
    }
    assert.ok(actual.day >= 1 && actual.day <= actual.daysInMonth, key)
    assert.ok(actual.daysInMonth === 29 || actual.daysInMonth === 30, key)
    count++
  }
  assert.equal(count, 73414)
  assert.equal(resolvedDays, 447)
  t.diagnostic(
    `${count} dates checked; ${disagreements} Intl differences independently resolved with HKO`,
  )
})

test('calendar lunar: known dates, lunar-year rollover, leap months and Gregorian boundaries', () => {
  for (const [year, month, day, lunarYear, lunarMonth, lunarDay, leap, ganzhi, zodiac] of [
    [2025, 1, 28, 2024, 12, 29, false, '甲辰', '龙'],
    [2025, 1, 29, 2025, 1, 1, false, '乙巳', '蛇'],
    [2025, 7, 25, 2025, 6, 1, true, '乙巳', '蛇'],
    [2025, 7, 27, 2025, 6, 3, true, '乙巳', '蛇'],
    [2023, 3, 22, 2023, 2, 1, true, '癸卯', '兔'],
    [2026, 2, 16, 2025, 12, 29, false, '乙巳', '蛇'],
    [2026, 2, 17, 2026, 1, 1, false, '丙午', '马'],
    [2026, 10, 30, 2026, 9, 21, false, '丙午', '马'],
    [1900, 1, 1, 1899, 12, 1, false, '己亥', '猪'],
    [1900, 1, 31, 1900, 1, 1, false, '庚子', '鼠'],
    [2100, 12, 31, 2100, 12, 1, false, '庚申', '猴'],
  ] as const) {
    const actual = lunarDate(at(year, month, day))
    assert.deepEqual(
      [actual.year, actual.month, actual.day, actual.isLeapMonth, actual.ganzhiYear, actual.zodiac],
      [lunarYear, lunarMonth, lunarDay, leap, ganzhi, zodiac],
    )
  }
  assert.equal(lunarDate(at(2025, 1, 29)).monthName, '正月')
  assert.equal(lunarDate(at(2025, 7, 27)).monthName, '闰六月')
  assert.equal(lunarDate(at(2023, 3, 22)).monthName, '闰二月')
  assert.equal(lunarDate(at(2026, 1, 1)).monthName, '冬月')
  assert.equal(lunarDate(at(2025, 1, 1)).monthName, '腊月')
  assert.equal(lunarDate(at(2026, 10, 30)).dayName, '廿一')
})

test('calendar solar terms: all 24 terms in 2025 and 2026 match the HKO published dates', () => {
  const names =
    '小寒 大寒 立春 雨水 惊蛰 春分 清明 谷雨 立夏 小满 芒种 夏至 小暑 大暑 立秋 处暑 白露 秋分 寒露 霜降 立冬 小雪 大雪 冬至'.split(
      ' ',
    )
  // Independent transcription of T2025c.txt and T2026c.txt, two dates per month.
  for (const [year, dates] of [
    [2025, [5, 20, 3, 18, 5, 20, 4, 20, 5, 21, 5, 21, 7, 22, 7, 23, 7, 23, 8, 23, 7, 22, 7, 21]],
    [2026, [5, 20, 4, 18, 5, 20, 5, 20, 5, 21, 5, 21, 7, 23, 7, 23, 7, 23, 8, 23, 7, 22, 7, 22]],
  ] as const)
    dates.forEach((day, i) =>
      assert.equal(solarTerm(at(year, Math.floor(i / 2) + 1, day)), names[i]),
    )
  assert.equal(solarTerm(at(2025, 1, 6)), undefined)
})

test('calendar solar terms: boundary years and near-midnight dates use the HKO civil day', () => {
  // HKO T1901c/T2021c/T2051c/T2083c/T2084c/T2100c; 1900 from lunar-javascript astronomy.
  for (const [y, m, d, name] of [
    [1900, 1, 6, '小寒'],
    [1900, 12, 22, '冬至'],
    [1901, 1, 6, '小寒'],
    [2021, 12, 21, '冬至'],
    [2051, 3, 20, '春分'],
    [2083, 2, 3, '立春'],
    [2084, 3, 19, '春分'],
    [2100, 12, 22, '冬至'],
  ] as const)
    assert.equal(solarTerm(at(y, m, d)), name, `${y}-${m}-${d}`)
  for (let year = 1900; year <= 2100; year++) {
    const found: string[] = []
    for (let time = Date.UTC(year, 0, 1); time < Date.UTC(year + 1, 0, 1); time += DAY) {
      const d = new Date(time)
      const term = solarTerm(at(year, d.getUTCMonth() + 1, d.getUTCDate()))
      if (term) found.push(term)
    }
    assert.equal(found.length, 24, String(year))
    assert.equal(new Set(found).size, 24, String(year))
  }
})

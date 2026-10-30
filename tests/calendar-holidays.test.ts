import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BUILTIN_HOLIDAYS,
  HOLIDAYS_2025,
  HOLIDAYS_2026,
  parseHolidayCn,
} from '../apps/desktop/src/main/calendar/index.js'

test('calendar holidays: every 2025 and 2026 exception matches the official notices', () => {
  // 国办发明电〔2024〕12号 and 国办发明电〔2025〕7号, independently enumerated dates.
  const expected = [
    [
      2025,
      HOLIDAYS_2025,
      '01-01 01-28 01-29 01-30 01-31 02-01 02-02 02-03 02-04 04-04 04-05 04-06 05-01 05-02 05-03 05-04 05-05 05-31 06-01 06-02 10-01 10-02 10-03 10-04 10-05 10-06 10-07 10-08',
      '01-26 02-08 04-27 09-28 10-11',
    ],
    [
      2026,
      HOLIDAYS_2026,
      '01-01 01-02 01-03 02-15 02-16 02-17 02-18 02-19 02-20 02-21 02-22 02-23 04-04 04-05 04-06 05-01 05-02 05-03 05-04 05-05 06-19 06-20 06-21 09-25 09-26 09-27 10-01 10-02 10-03 10-04 10-05 10-06 10-07',
      '01-04 02-14 02-28 05-09 09-20 10-10',
    ],
  ] as const
  for (const [year, table, off, work] of expected) {
    for (const [isOffDay, dates] of [
      [true, off],
      [false, work],
    ] as const)
      assert.deepEqual(
        Object.entries(table)
          .filter(([, value]) => value.isOffDay === isOffDay)
          .map(([key]) => key)
          .sort(),
        dates
          .split(' ')
          .map((d) => `${year}-${d}`)
          .sort(),
      )
    assert.ok(Object.isFrozen(table))
  }
  assert.equal(Object.keys(BUILTIN_HOLIDAYS).length, 72)
})

test('calendar holidays: parse holiday-cn objects and JSON text without retaining mutable inputs', () => {
  const data = {
    year: 2028,
    days: [
      { name: ' 元旦 ', date: '2028-01-01', isOffDay: true },
      { name: '春节', date: '2028-02-29', isOffDay: false },
    ],
  }
  const table = parseHolidayCn(data)
  assert.deepEqual({ ...table['2028-01-01'] }, { name: '元旦', isOffDay: true })
  assert.equal(table['2028-02-29']?.isOffDay, false)
  assert.deepEqual(table, parseHolidayCn(JSON.stringify(data)))
  data.days[0]!.isOffDay = false
  assert.equal(table['2028-01-01']?.isOffDay, true)
  assert.ok(Object.isFrozen(table))
  assert.ok(Object.isFrozen(table['2028-01-01']))
  assert.equal(Object.keys(parseHolidayCn({ year: 2027, days: [] })).length, 0)
})

test('calendar holidays: reject malformed updates atomically, including duplicate or impossible dates', () => {
  const valid = { name: '测试', date: '2026-01-01', isOffDay: true }
  for (const input of [
    null,
    false,
    [],
    {},
    '{',
    { year: '2026', days: [] },
    { year: 2026.5, days: [] },
    { year: 1899, days: [] },
    { year: 2101, days: [] },
    { year: 2026, days: {} },
    { year: 2026, days: [null] },
    { year: 2026, days: [valid, valid] },
    ...[
      { name: '' },
      { name: '  ' },
      { name: 2 },
      { date: '2026-1-01' },
      { date: '2025-01-01' },
      { date: '2026-02-29' },
      { date: '2026-04-31' },
      { date: '2026-00-01' },
      { date: '2026-13-01' },
      { date: '2026-01-00' },
      { date: '2026-01-01T00:00:00Z' },
      { date: '__proto__' },
      { isOffDay: 1 },
      { isOffDay: 'false' },
      { isOffDay: undefined },
    ].map((patch) => ({ year: 2026, days: [valid, { ...valid, ...patch }] })),
  ])
    assert.throws(() => parseHolidayCn(input))
  assert.equal(Object.keys(BUILTIN_HOLIDAYS).length, 72)
})

test('calendar holidays: a break may cross the new year, but only by days of the neighbouring year', () => {
  const day = (date: string, isOffDay = true) => ({ name: '元旦', date, isOffDay })
  const table = parseHolidayCn({
    year: 2023,
    days: [
      day('2022-12-20'),
      day('2022-12-31'),
      day('2023-01-01'),
      day('2023-01-02'),
      day('2024-01-01'),
      day('2024-01-10', false),
    ],
  })
  assert.deepEqual(Object.keys(table).sort(), [
    '2022-12-20',
    '2022-12-31',
    '2023-01-01',
    '2023-01-02',
    '2024-01-01',
    '2024-01-10',
  ])
  assert.equal(table['2022-12-31']?.isOffDay, true, 'keyed by its own date')
  assert.equal(table['2024-01-10']?.isOffDay, false)
  for (const date of [
    '2022-12-19',
    '2022-11-30',
    '2022-06-01',
    '2024-01-11',
    '2024-02-01',
    '2021-12-31',
    '2025-01-01',
    '2022-12-32',
    '2022-02-30',
  ])
    assert.throws(() => parseHolidayCn({ year: 2023, days: [day(date)] }), date)
})

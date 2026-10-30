import assert from 'node:assert/strict'
import test from 'node:test'
import { buildMonthCalendar, lunarDate } from '../apps/desktop/src/main/calendar/index.js'

// The device font has native 12 px glyphs only for these characters (firmware 0.0.29+);
// anything else in a label falls back to 14 px and a four-character label may be shortened.
// When this test fails, regenerate the firmware's calendar character set, then update this list.
const DEVICE_CALENDAR_CHARS =
  'gÁ一丁七三丑丙中乐乙九二五亥儿元党八六军冬分初动劳十午卯周四国壬处夏夕大头女妇子字宵寅寒小己巳师年庆庚建廿快惊戊戌抬教日旦明春暑月未标树植正水清满班甲申癸白秋种立童端第签腊至节芒蛰谷辛辰酉重闰阳降除雨雪霜露青龙'

test('every calendar label and lunar header from 1900 to 2100 has native device glyphs', () => {
  const known = new Set(DEVICE_CALENDAR_CHARS)
  const missing = new Set<string>()
  const check = (text: string) => { for (const ch of text) if (ch !== ' ' && !known.has(ch)) missing.add(ch) }
  for (let year = 1900; year <= 2100; year++) for (let month = 0; month < 12; month++) {
    const calendar = buildMonthCalendar(new Date(year, month, 1, 12))
    calendar.labels.forEach(check)
    for (let day = 1; day <= calendar.days; day++) {
      const lunar = lunarDate(new Date(year, month, day, 12))
      check(`${lunar.ganzhiYear}年${lunar.monthName}${lunar.dayName}`)
    }
  }
  check('一二三四五六日第周班年月')
  assert.deepEqual([...missing], [], 'regenerate the firmware calendar character set')
})

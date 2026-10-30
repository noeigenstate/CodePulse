import { civilDate, dateKey, DAY_MS, monthDays } from './civil.js'
import { BUILTIN_HOLIDAYS, type HolidayTable } from './holidays.js'
import { lunarDate, type LunarDate } from './lunar.js'
import { solarTerm } from './solar-terms.js'

export {
  BUILTIN_HOLIDAYS,
  HOLIDAYS_2025,
  HOLIDAYS_2026,
  HOLIDAY_SOURCES,
  parseHolidayCn,
} from './holidays.js'
export type { Holiday, HolidayTable } from './holidays.js'
export { lunarDate } from './lunar.js'
export type { LunarDate } from './lunar.js'
export { solarTerm } from './solar-terms.js'

/** Firmware calendar payload. first is Monday-based; today=0 is reserved for another month. */
export interface DeviceCalendar {
  year: number
  month: number
  today: number
  first: number
  days: number
  lunar: string
  week: number
  labels: string[]
  flags: number[]
}

const SOLAR_FESTIVALS: Readonly<Record<string, string>> = {
  '1-1': '元旦',
  '3-8': '妇女节',
  '3-12': '植树节',
  '5-1': '劳动节',
  '5-4': '青年节',
  '6-1': '儿童节',
  '7-1': '建党节',
  '8-1': '建军节',
  '9-10': '教师节',
  '10-1': '国庆节',
}
const LUNAR_FESTIVALS: Readonly<Record<string, string>> = {
  '1-1': '春节',
  '1-15': '元宵节',
  '2-2': '龙抬头',
  '5-5': '端午节',
  '7-7': '七夕',
  '7-15': '中元节',
  '8-15': '中秋节',
  '9-9': '重阳节',
  '12-8': '腊八节',
  '12-23': '小年',
}

/** ISO 8601 week number of the local day, including the previous/next ISO week-year. */
export function isoWeek(date: Date): number {
  const { year, month, day } = civilDate(date)
  const thursday = new Date(Date.UTC(year, month - 1, day))
  thursday.setUTCDate(thursday.getUTCDate() + 3 - ((thursday.getUTCDay() + 6) % 7))
  return (
    Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * DAY_MS)) + 1
  )
}

function lunarFestival(lunar: LunarDate): string | undefined {
  if (lunar.isLeapMonth) return undefined
  if (lunar.month === 12 && lunar.day === lunar.daysInMonth) return '除夕'
  return LUNAR_FESTIVALS[`${lunar.month}-${lunar.day}`]
}

/** A supplied table replaces the defaults; callers can merge yearly updates with BUILTIN_HOLIDAYS. */
export function buildMonthCalendar(
  now: Date,
  holidays: HolidayTable = BUILTIN_HOLIDAYS,
): DeviceCalendar {
  const { year, month, day: today } = civilDate(now)
  const first = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
  const days = monthDays(year, month)
  const labels: string[] = [],
    flags: number[] = []
  for (let day = 1; day <= days; day++) {
    const date = new Date(year, month - 1, day, 12)
    const lunar = lunarDate(date)
    const special = lunarFestival(lunar) ?? SOLAR_FESTIVALS[`${month}-${day}`] ?? solarTerm(date)
    labels.push(special ?? (lunar.day === 1 ? lunar.monthName : lunar.dayName))
    const key = dateKey(year, month, day)
    const holiday = Object.hasOwn(holidays, key) ? holidays[key] : undefined
    const weekend = (first + day - 1) % 7 >= 5
    const numeric = holiday ? (holiday.isOffDay ? 1 | 4 : 8) : weekend ? 1 : 0
    flags.push(numeric | (special ? 2 : 0))
  }
  const lunar = lunarDate(now)
  return {
    year,
    month,
    today,
    first,
    days,
    lunar: `${lunar.ganzhiYear}年 ${lunar.monthName}${lunar.dayName}`,
    week: isoWeek(now),
    labels,
    flags,
  }
}

/** Stable for a local day. Scheduling, layout selection and delivery belong to the caller. */
export function calendarCardFields(
  now: Date,
  holidays?: HolidayTable,
): {
  id: string
  source: string
  text: string
  calendar: DeviceCalendar
} {
  const calendar = buildMonthCalendar(now, holidays)
  const lunar = lunarDate(now)
  const weekday = '一二三四五六日'[(calendar.first + calendar.today - 1) % 7]
  return {
    id: `calendar:${dateKey(calendar.year, calendar.month, calendar.today)}`,
    source: '日历',
    text: `${calendar.month}月${calendar.today}日 周${weekday} · 农历${lunar.monthName}${lunar.dayName} · 第${calendar.week}周`,
    calendar,
  }
}

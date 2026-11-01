import { civilDate, DAY_MS } from './civil.js'
import { LUNAR_YEARS } from './data.js'

export interface LunarDate {
  year: number
  month: number
  day: number
  isLeapMonth: boolean
  ganzhiYear: string
  zodiac: string
  monthName: string
  dayName: string
  daysInMonth: number
}

const MONTH_NAMES = [
  '正月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '冬月',
  '腊月',
]
const DAY_NAMES = [
  '初一',
  '初二',
  '初三',
  '初四',
  '初五',
  '初六',
  '初七',
  '初八',
  '初九',
  '初十',
  '十一',
  '十二',
  '十三',
  '十四',
  '十五',
  '十六',
  '十七',
  '十八',
  '十九',
  '二十',
  '廿一',
  '廿二',
  '廿三',
  '廿四',
  '廿五',
  '廿六',
  '廿七',
  '廿八',
  '廿九',
  '三十',
]

function newYear(year: number): number {
  const [date] = LUNAR_YEARS[year - 1899]!
  return Date.UTC(year, Math.floor(date / 100) - 1, date % 100)
}

/** The Chinese civil calendar (UTC+08:00 convention) for the supplied local date fields. */
export function lunarDate(date: Date): LunarDate {
  const { year: solarYear, month: solarMonth, day: solarDay } = civilDate(date)
  const utc = Date.UTC(solarYear, solarMonth - 1, solarDay)
  const year = utc < newYear(solarYear) ? solarYear - 1 : solarYear
  const [, leapMonth, monthBits] = LUNAR_YEARS[year - 1899]!
  let offset = (utc - newYear(year)) / DAY_MS,
    index = 0
  const length = (i: number) => 29 + ((monthBits >> i) & 1)
  while (offset >= length(index)) {
    offset -= length(index)
    index++
  }
  const isLeapMonth = leapMonth > 0 && index === leapMonth
  const month = index + 1 - (leapMonth > 0 && index >= leapMonth ? 1 : 0)
  const day = offset + 1
  return {
    year,
    month,
    day,
    isLeapMonth,
    ganzhiYear:
      '甲乙丙丁戊己庚辛壬癸'[(year - 4) % 10]! + '子丑寅卯辰巳午未申酉戌亥'[(year - 4) % 12]!,
    zodiac: '鼠牛虎兔龙蛇马羊猴鸡狗猪'[(year - 4) % 12]!,
    monthName: `${isLeapMonth ? '闰' : ''}${MONTH_NAMES[month - 1]}`,
    dayName: DAY_NAMES[day - 1]!,
    daysInMonth: length(index),
  }
}

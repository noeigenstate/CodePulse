import { dateKey, monthDays } from './civil.js'

export interface Holiday {
  readonly name: string
  readonly isOffDay: boolean
}

/** Only announced exceptions to the ordinary workweek. Names never become cell labels. */
export type HolidayTable = Readonly<Record<string, Holiday>>

/**
 * Accept a holiday-cn object or its JSON text; reject the whole update on invalid input. Dates
 * belong to the declared year, plus 20-31 December before it and 1-10 January after it; each entry
 * is keyed by its own date, so a merge files it under the year it falls in.
 */
export function parseHolidayCn(input: unknown): HolidayTable {
  const value: unknown = typeof input === 'string' ? JSON.parse(input) : input
  if (!value || typeof value !== 'object') throw new TypeError('Expected a holiday-cn object')
  const { year, days } = value as Record<string, unknown>
  if (!Number.isInteger(year) || (year as number) < 1900 || (year as number) > 2100)
    throw new RangeError('Holiday year must be an integer from 1900 to 2100')
  if (!Array.isArray(days) || days.length > 366) throw new TypeError('Invalid holiday days')
  const table: Record<string, Holiday> = Object.create(null)
  for (const item of days) {
    if (!item || typeof item !== 'object') throw new TypeError('Invalid holiday entry')
    const { name, date, isOffDay } = item as Record<string, unknown>
    if (typeof name !== 'string' || !name.trim() || typeof isOffDay !== 'boolean')
      throw new TypeError('Holiday entries require a name and boolean isOffDay')
    const match = typeof date === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) throw new TypeError('Holiday date must be YYYY-MM-DD')
    const dateYear = Number(match[1]),
      month = Number(match[2]),
      day = Number(match[3])
    // holiday-cn files hold the breaks announced for their year, so a New Year break can reach back
    // to late December (2023.json lists 2022-12-31) and a Spring Festival one forward into January.
    const inYear =
      dateYear === year ||
      (dateYear === (year as number) - 1 && month === 12 && day >= 20) ||
      (dateYear === (year as number) + 1 && month === 1 && day <= 10)
    if (!inYear || month < 1 || month > 12 || day < 1 || day > monthDays(dateYear, month))
      throw new RangeError(`Holiday date is outside the declared year: ${date}`)
    if (Object.hasOwn(table, date as string)) throw new TypeError(`Duplicate holiday date: ${date}`)
    table[date as string] = Object.freeze({ name: name.trim(), isOffDay })
  }
  return Object.freeze(table)
}

export const HOLIDAY_SOURCES = Object.freeze({
  2025: 'https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm',
  2026: 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm',
})

function announcedHolidays(
  year: number,
  breaks: readonly (readonly [name: string, month: number, first: number, last: number])[],
  workdays: readonly (readonly [name: string, month: number, day: number])[],
): HolidayTable {
  const days: { name: string; date: string; isOffDay: boolean }[] = []
  for (const [name, month, first, last] of breaks)
    for (let day = first; day <= last; day++)
      days.push({ name, date: dateKey(year, month, day), isOffDay: true })
  for (const [name, month, day] of workdays)
    days.push({ name, date: dateKey(year, month, day), isOffDay: false })
  return parseHolidayCn({ year, days })
}

/** 国办发明电〔2024〕12号; checked against the official notice, not inferred festival dates. */
export const HOLIDAYS_2025 = announcedHolidays(
  2025,
  [
    ['元旦', 1, 1, 1],
    ['春节', 1, 28, 31],
    ['春节', 2, 1, 4],
    ['清明节', 4, 4, 6],
    ['劳动节', 5, 1, 5],
    ['端午节', 5, 31, 31],
    ['端午节', 6, 1, 2],
    ['国庆节、中秋节', 10, 1, 8],
  ],
  [
    ['春节', 1, 26],
    ['春节', 2, 8],
    ['劳动节', 4, 27],
    ['国庆节、中秋节', 9, 28],
    ['国庆节、中秋节', 10, 11],
  ],
)

/** 国办发明电〔2025〕7号, published 2025-11-04. */
export const HOLIDAYS_2026 = announcedHolidays(
  2026,
  [
    ['元旦', 1, 1, 3],
    ['春节', 2, 15, 23],
    ['清明节', 4, 4, 6],
    ['劳动节', 5, 1, 5],
    ['端午节', 6, 19, 21],
    ['中秋节', 9, 25, 27],
    ['国庆节', 10, 1, 7],
  ],
  [
    ['元旦', 1, 4],
    ['春节', 2, 14],
    ['春节', 2, 28],
    ['劳动节', 5, 9],
    ['国庆节', 9, 20],
    ['国庆节', 10, 10],
  ],
)

export const BUILTIN_HOLIDAYS: HolidayTable = Object.freeze({ ...HOLIDAYS_2025, ...HOLIDAYS_2026 })

import type { AmbientCard, CalendarNextHoliday } from '@codepulse/shared'
import {
  BUILTIN_HOLIDAYS,
  calendarCardFields,
  parseHolidayCn,
  type HolidayTable,
} from './calendar/index.js'
import type { JsonRequest } from './ambient-sources.js'

/** Public static file per year; same-year data replaces the built-in table when it validates. */
export const holidayUrl = (year: number) =>
  `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`

const pad = (n: number) => String(n).padStart(2, '0')
const localDay = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const dayNumber = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!) / 86400000
}

/** The year being used, plus next year from November on (when the State Council announces it). */
export function holidayYears(now: number): number[] {
  const d = new Date(now)
  return d.getMonth() >= 10 ? [d.getFullYear(), d.getFullYear() + 1] : [d.getFullYear()]
}

/**
 * One remote year, or undefined if it must be ignored: it has to parse as holiday-cn, declare the
 * requested year and carry at least one day (an empty file must not wipe the built-in year).
 */
export function parseRemoteYear(year: number, input: unknown): HolidayTable | undefined {
  try {
    const table = parseHolidayCn(input)
    const keys = Object.keys(table)
    return keys.length && keys.every((k) => k.startsWith(`${year}-`)) ? table : undefined
  } catch {
    return undefined
  }
}

/** Remote years replace the same built-in year as a whole; other years are added. */
export function mergeHolidays(
  builtin: HolidayTable,
  remote: Readonly<Record<number, HolidayTable>>,
): HolidayTable {
  const replaced = new Set(Object.keys(remote))
  const merged: Record<string, HolidayTable[string]> = {}
  for (const [key, value] of Object.entries(builtin))
    if (!replaced.has(key.slice(0, 4))) merged[key] = value
  for (const table of Object.values(remote)) Object.assign(merged, table)
  return Object.freeze(merged)
}

/** On-disk shape: validated holiday-cn objects per year, and the last day each year was tried. */
export interface HolidayCache {
  version: 1
  years: Record<string, { year: number; days: { name: string; date: string; isOffDay: boolean }[] }>
  attempts: Record<string, string>
}
const tableToCn = (year: number, table: HolidayTable) => ({
  year,
  days: Object.entries(table).map(([date, h]) => ({ name: h.name, date, isOffDay: h.isOffDay })),
})

/**
 * Holiday table used by the calendar card: built-in years, overridden by validated remote years.
 * The remote copy is kept in a cache file, fetched at most once per year per day (a failure
 * counts), and never disturbs the calendar: every failure just leaves the previous table.
 */
export class HolidayStore {
  private remote: Record<number, HolidayTable> = {}
  private attempts: Record<string, string> = {}
  private merged: HolidayTable = BUILTIN_HOLIDAYS
  private syncing = false
  /** Bumps whenever the merged table changes, so cached calendar cards know to rebuild. */
  version = 0
  private cached: { key: string; card: AmbientCard } | undefined
  private upcoming: { key: string; value: CalendarNextHoliday | undefined } | undefined
  constructor(
    raw?: unknown,
    private save?: (cache: HolidayCache) => void,
    private builtin: HolidayTable = BUILTIN_HOLIDAYS,
  ) {
    const cache = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
    const years = cache.years && typeof cache.years === 'object' ? cache.years : {}
    for (const [key, value] of Object.entries(years)) {
      const year = Number(key)
      const table = Number.isInteger(year) ? parseRemoteYear(year, value) : undefined
      if (table) this.remote[year] = table
    }
    const attempts = cache.attempts && typeof cache.attempts === 'object' ? cache.attempts : {}
    for (const [key, value] of Object.entries(attempts))
      if (/^\d{4}$/.test(key) && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))
        this.attempts[key] = value
    this.merged = mergeHolidays(this.builtin, this.remote)
  }
  table(): HolidayTable {
    return this.merged
  }
  /** Next break for the local day of `now`, rebuilt only when the day or the table changes. */
  next(now: number): CalendarNextHoliday | undefined {
    const key = `${localDay(now)}:${this.version}`
    if (this.upcoming?.key !== key) this.upcoming = { key, value: nextHoliday(now, this.merged) }
    return this.upcoming.value
  }
  /** The calendar card for the local day of `now`, rebuilt only when the day or the table changes. */
  card(now: number): AmbientCard {
    const key = `${localDay(now)}:${this.version}`
    if (this.cached?.key === key) return this.cached.card
    const card = calendarCard(now, this.merged)
    this.cached = { key, card }
    return card
  }
  private persist(now: number) {
    const keep = new Date(now).getFullYear()
    for (const year of Object.keys(this.remote))
      if (Number(year) < keep) delete this.remote[Number(year)]
    for (const year of Object.keys(this.attempts))
      if (Number(year) < keep) delete this.attempts[year]
    try {
      this.save?.({
        version: 1,
        years: Object.fromEntries(
          Object.entries(this.remote).map(([year, table]) => [
            year,
            tableToCn(Number(year), table),
          ]),
        ),
        attempts: this.attempts,
      })
    } catch {
      /* The cache is an optimisation; keep running from memory. */
    }
  }
  /** Fetch this year (and next from November) once per day each. Resolves true if the table changed. */
  async sync(
    now: number,
    request: JsonRequest,
    alive: () => boolean = () => true,
  ): Promise<boolean> {
    const today = localDay(now)
    const due = holidayYears(now).filter((year) => this.attempts[year] !== today)
    if (this.syncing || !due.length) return false
    this.syncing = true
    let changed = false
    try {
      for (const year of due) {
        this.attempts[year] = today
        this.persist(now)
        let table: HolidayTable | undefined
        try {
          table = parseRemoteYear(year, await request(holidayUrl(year)))
        } catch {
          table = undefined
        }
        if (!alive()) return changed
        if (!table || JSON.stringify(table) === JSON.stringify(this.remote[year])) continue
        this.remote[year] = table
        this.merged = mergeHolidays(this.builtin, this.remote)
        this.version++
        changed = true
        this.persist(now)
      }
    } finally {
      this.syncing = false
    }
    return changed
  }
}

/**
 * The calendar card for the local day of `now`. It is only offered for that day, so it expires at
 * the next local midnight; its id carries the date, so it can be shown at most once a day.
 */
export function calendarCard(now: number, holidays?: HolidayTable): AmbientCard {
  const date = new Date(now)
  const fields = calendarCardFields(date, holidays)
  return {
    id: fields.id,
    kind: 'calendar',
    source: fields.source,
    text: fields.text,
    url: '',
    publishedAt: new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime(),
    expiresAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
    score: 0,
    layout: 'calendar',
    calendar: fields.calendar,
  }
}

/**
 * The break that is going on today, or the first day off of the next one. Only days the table marks
 * as off count (a make-up workday does not), so a weekend before a break is not "the holiday".
 */
export function nextHoliday(now: number, holidays: HolidayTable): CalendarNextHoliday | undefined {
  const today = localDay(now)
  const todayEntry = Object.hasOwn(holidays, today) ? holidays[today] : undefined
  if (todayEntry?.isOffDay) return { name: todayEntry.name, date: today, inDays: 0, ongoing: true }
  const next = Object.keys(holidays)
    .filter((date) => date > today && holidays[date]!.isOffDay)
    .sort()[0]
  return next
    ? {
        name: holidays[next]!.name,
        date: next,
        inDays: dayNumber(next) - dayNumber(today),
        ongoing: false,
      }
    : undefined
}

export const DAY_MS = 86400000

/** Treat a Date as a local civil day; UTC arithmetic then avoids DST and date-string shifts. */
export function civilDate(date: Date): { year: number; month: number; day: number } {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid calendar date')
  const year = date.getFullYear()
  if (year < 1900 || year > 2100) throw new RangeError('Calendar supports years 1900–2100')
  return { year, month: date.getMonth() + 1, day: date.getDate() }
}

export function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

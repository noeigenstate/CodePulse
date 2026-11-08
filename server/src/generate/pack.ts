import type { PluginCard } from '@codepulse/shared'
import { validateCards } from '../validation.js'

export function localDay(now: number, timeZone = 'Asia/Shanghai'): { index: number; end: number } {
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone,
    calendar: 'iso8601',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const indexAt = (time: number): number => {
    const parts = Object.fromEntries(
      formatter.formatToParts(time).map(({ type, value }) => [type, value]),
    )
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400000
  }
  const index = indexAt(now)
  let low = now
  let high = now + 48 * 3600000
  // Search for the next date boundary rather than assuming every day has 24 hours.
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (indexAt(middle) === index) low = middle
    else high = middle
  }
  return { index, end: high }
}

export function packCard(
  cards: Record<string, unknown>[],
  now: number,
  timeZone = 'Asia/Shanghai',
): PluginCard[] {
  const { index, end } = localDay(now, timeZone)
  const selected = cards[((index % cards.length) + cards.length) % cards.length]
  return validateCards([{ ...selected, expiresAt: end }], now, end, 1)
}

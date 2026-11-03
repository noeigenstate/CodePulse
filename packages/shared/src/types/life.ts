/** Bounded, additive device protocol: always send the legacy text beside this payload. */
export type LifeDirection = 'up' | 'down' | 'flat'
export const LIFE_WEATHER_ICONS = [
  'sun',
  'cloudsun',
  'cloud',
  'rain',
  'snow',
  'thunder',
  'fog',
] as const
export type LifeWeatherIcon = (typeof LIFE_WEATHER_ICONS)[number]
interface LifeBase {
  v: 1
}
export interface LifeWeather extends LifeBase {
  kind: 'weather'
  icon: LifeWeatherIcon
  place: string
  low: string
  high: string
  condition: string
  feels: string
  wind: string
  humidity: string
  air: string
  restriction: string
  sunset: string
  tomorrow?: { icon: LifeWeatherIcon; low: string; high: string; condition: string }
}
export interface LifeGold extends LifeBase {
  kind: 'gold'
  hero: string
  direction: LifeDirection
  percent: string
  change: string
  low: string
  high: string
  international: string
  internationalPercent: string
  brand: string
  brandPrice: string
  source: string
}
export interface LifeStock extends LifeBase {
  kind: 'stock'
  name: string
  symbol: string
  hero: string
  direction: LifeDirection
  state: 'open' | 'closed' | 'unknown'
  percent: string
  change: string
  low: string
  high: string
  open: string
  previous: string
  source: string
}
export interface LifeTool extends LifeBase {
  kind: 'tool'
  icon: 'codex' | 'claude' | 'tool'
  name: string
  date: string
  source: string
  command: string
  title: string
  summary: string
}
export interface LifeNews extends LifeBase {
  kind: 'news'
  headlines: { title: string; source: string }[]
}
export interface LifeHoliday extends LifeBase {
  kind: 'holiday'
  year: number
  state: 'published' | 'pending'
  /** A fixed Gregorian holiday anchor, not a State Council break estimate. */
  next: { name: string; date: string; days: number }
  /** Only present when the official notice actually supplies a validated date range. */
  range?: { name: string; start: string; end: string; days: number }
  label: string
}
export type DeviceLife = LifeWeather | LifeGold | LifeStock | LifeTool | LifeNews | LifeHoliday

const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const string = (v: unknown, max: number, required = false): v is string =>
  typeof v === 'string' &&
  Array.from(v).length <= max &&
  (!required || v.length > 0) &&
  !/[\u0000-\u001f\u007f-\u009f]/u.test(v)
const integer = (v: unknown, low: number, high: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= low && v <= high
const numeric = (v: unknown, required = false, percent = false): v is string =>
  string(v, 16, required) &&
  (v === '' ||
    (percent ? /^[+-]?\d{1,10}(?:\.\d{1,6})?%?$/ : /^[+-]?\d{1,10}(?:\.\d{1,6})?$/).test(v))
export function lifeDate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  if (year < 1900 || year > 2101) return undefined
  const time = Date.UTC(year, month - 1, day)
  return new Date(time).toISOString().slice(0, 10) === value ? time : undefined
}
/** Strict shape/capacity validation; the desktop separately checks the device's glyph repertoire. */
export function normalizeDeviceLife(value: unknown): DeviceLife | undefined {
  const p = object(value)
  if (p.v !== 1) return undefined
  const strings = (fields: Record<string, number>, required: string[] = []) =>
    Object.entries(fields).every(([key, max]) => string(p[key], max, required.includes(key)))
  const numbers = (fields: string[], required: string[] = []) =>
    fields.every((key) =>
      numeric(p[key], required.includes(key), key.toLowerCase().includes('percent')),
    )
  const oneOf = (input: unknown, choices: string[]) =>
    typeof input === 'string' && choices.includes(input)
  const direction = () => oneOf(p.direction, ['up', 'down', 'flat'])
  switch (p.kind) {
    case 'weather': {
      if (
        !LIFE_WEATHER_ICONS.includes(p.icon as LifeWeatherIcon) ||
        !strings({ place: 20, condition: 16, wind: 24, restriction: 16, sunset: 5 }, [
          'condition',
        ]) ||
        !numbers(['low', 'high', 'feels', 'humidity', 'air'], ['low', 'high']) ||
        (p.sunset !== '' &&
          (!/^\d\d:\d\d$/.test(p.sunset as string) ||
            Number((p.sunset as string).slice(0, 2)) > 23 ||
            Number((p.sunset as string).slice(3)) > 59))
      )
        return undefined
      if (p.tomorrow !== undefined) {
        const t = object(p.tomorrow)
        if (
          !LIFE_WEATHER_ICONS.includes(t.icon as LifeWeatherIcon) ||
          !numeric(t.low, true) ||
          !numeric(t.high, true) ||
          !string(t.condition, 16, true)
        )
          return undefined
      }
      break
    }
    case 'gold':
      if (
        !direction() ||
        !numbers(
          [
            'hero',
            'percent',
            'change',
            'low',
            'high',
            'international',
            'internationalPercent',
            'brandPrice',
          ],
          ['hero'],
        ) ||
        !strings({ brand: 12, source: 20 })
      )
        return undefined
      break
    case 'stock':
      if (
        !direction() ||
        !oneOf(p.state, ['open', 'closed', 'unknown']) ||
        !strings({ name: 20, symbol: 16, source: 20 }, ['symbol']) ||
        !/^[A-Z0-9]{1,10}\.(?:US|HK|SH|SZ)$/.test(p.symbol as string) ||
        !numbers(['hero', 'percent', 'change', 'low', 'high', 'open', 'previous'], ['hero'])
      )
        return undefined
      break
    case 'tool':
      if (
        !oneOf(p.icon, ['codex', 'claude', 'tool']) ||
        !strings({ name: 24, date: 12, source: 8, command: 20, title: 48, summary: 96 }, [
          'name',
          'title',
        ]) ||
        !/^[\x20-\x7e]*$/.test(p.command as string)
      )
        return undefined
      break
    case 'news':
      if (
        !Array.isArray(p.headlines) ||
        p.headlines.length < 1 ||
        p.headlines.length > 4 ||
        !p.headlines.every((item) => {
          const h = object(item)
          return string(h.title, 28, true) && string(h.source, 8)
        })
      )
        return undefined
      break
    case 'holiday': {
      if (
        !integer(p.year, 1900, 2100) ||
        !oneOf(p.state, ['pending', 'published']) ||
        !string(p.label, 12)
      )
        return undefined
      const next = object(p.next),
        date = lifeDate(next.date)
      if (!string(next.name, 12, true) || date === undefined || !integer(next.days, 0, 366))
        return undefined
      if (p.range !== undefined) {
        const r = object(p.range),
          start = lifeDate(r.start),
          end = lifeDate(r.end)
        if (
          p.state !== 'published' ||
          !string(r.name, 12, true) ||
          start === undefined ||
          end === undefined ||
          !integer(r.days, 1, 31) ||
          (end - start) / 86400000 + 1 !== r.days
        )
          return undefined
        const a = new Date(start),
          b = new Date(end)
        if (
          !(
            (a.getUTCFullYear() === p.year && b.getUTCFullYear() === p.year) ||
            (r.name === '元旦' &&
              a.getUTCFullYear() === p.year - 1 &&
              a.getUTCMonth() === 11 &&
              b.getUTCFullYear() === p.year &&
              b.getUTCMonth() === 0)
          )
        )
          return undefined
      }
      break
    }
    default:
      return undefined
  }
  // Copy only protocol fields; no caller-owned mutable objects cross the projection boundary.
  const keys: Record<string, string[]> = {
    weather: [
      'icon',
      'place',
      'low',
      'high',
      'condition',
      'feels',
      'wind',
      'humidity',
      'air',
      'restriction',
      'sunset',
      'tomorrow',
    ],
    gold: [
      'hero',
      'direction',
      'percent',
      'change',
      'low',
      'high',
      'international',
      'internationalPercent',
      'brand',
      'brandPrice',
      'source',
    ],
    stock: [
      'name',
      'symbol',
      'hero',
      'direction',
      'state',
      'percent',
      'change',
      'low',
      'high',
      'open',
      'previous',
      'source',
    ],
    tool: ['icon', 'name', 'date', 'source', 'command', 'title', 'summary'],
    news: ['headlines'],
    holiday: ['year', 'state', 'next', 'range', 'label'],
  }
  const clean = Object.fromEntries(
    ['v', 'kind', ...keys[p.kind as string]!]
      .filter((key) => p[key] !== undefined)
      .map((key) => [key, p[key]]),
  )
  if (p.kind === 'weather' && p.tomorrow) {
    const t = object(p.tomorrow)
    clean.tomorrow = { icon: t.icon, low: t.low, high: t.high, condition: t.condition }
  }
  if (p.kind === 'news')
    clean.headlines = (p.headlines as Record<string, unknown>[]).map((h) => ({
      title: h.title,
      source: h.source,
    }))
  if (p.kind === 'holiday') {
    const n = object(p.next)
    clean.next = { name: n.name, date: n.date, days: n.days }
    if (p.range) {
      const r = object(p.range)
      clean.range = { name: r.name, start: r.start, end: r.end, days: r.days }
    }
  }
  return clean as unknown as DeviceLife
}

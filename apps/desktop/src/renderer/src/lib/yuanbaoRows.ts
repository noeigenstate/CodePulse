import type { YuanbaoConfig } from '@codepulse/shared'
import type { StorageLike } from './ambientSocial.js'

/**
 * 元宝搜索 rows on the 桌边内容 page. `enabled` is never shown: it is derived from the six feature
 * flags on every save, and main only requests when `enabled && <feature> && a saved key`.
 */
export type YuanbaoFlag = 'weatherEnabled' | 'goldEnabled' | 'stocksEnabled' | 'toolsEnabled' | 'holidayEnabled' | 'newsEnabled'

const FLAGS: YuanbaoFlag[] = ['weatherEnabled', 'goldEnabled', 'stocksEnabled', 'toolsEnabled', 'holidayEnabled', 'newsEnabled']

/** `enabled` equals the OR of the six feature flags. */
export const deriveYuanbaoEnabled = (config: YuanbaoConfig): boolean => FLAGS.some((flag) => config[flag])

export function withDerivedEnabled(config: YuanbaoConfig): YuanbaoConfig {
  return { ...config, enabled: deriveYuanbaoEnabled(config) }
}

/** Set one feature flag and re-derive `enabled`. */
export function setYuanbaoFlag(config: YuanbaoConfig, flag: YuanbaoFlag, value: boolean): YuanbaoConfig {
  return withDerivedEnabled({ ...config, [flag]: value })
}

/** The three features behind the single 「生活卡」 row switch. */
export interface LifeTriple {
  weatherEnabled: boolean
  goldEnabled: boolean
  stocksEnabled: boolean
}

export const LIFE_TRIPLE_KEY = 'codepulse:ambient-life-triple'
export const lifeRowOn = (triple: LifeTriple): boolean => triple.weatherEnabled || triple.goldEnabled || triple.stocksEnabled
export const lifeTripleOf = (config: YuanbaoConfig): LifeTriple => ({
  weatherEnabled: config.weatherEnabled,
  goldEnabled: config.goldEnabled,
  stocksEnabled: config.stocksEnabled,
})

/**
 * Turning the row off remembers exactly which of the three were on; turning it on restores that
 * triple. With nothing remembered only weather turns on, so one switch never starts every paid request.
 */
export function toggleLifeRow(
  current: LifeTriple,
  remembered: LifeTriple | undefined,
): { patch: LifeTriple; remembered: LifeTriple | undefined } {
  if (lifeRowOn(current)) {
    return { patch: { weatherEnabled: false, goldEnabled: false, stocksEnabled: false }, remembered: { ...current } }
  }
  if (remembered && lifeRowOn(remembered)) return { patch: { ...remembered }, remembered }
  return { patch: { weatherEnabled: true, goldEnabled: false, stocksEnabled: false }, remembered }
}

/**
 * An individual weather / gold / stocks toggle in the category's 设置 is the user's latest explicit
 * choice and replaces the memory; leaving all three off forgets it (the row then falls back to weather).
 */
export function rememberAfterLifeFlag(current: LifeTriple, flag: keyof LifeTriple, value: boolean): LifeTriple | undefined {
  const next = { ...current, [flag]: value }
  return lifeRowOn(next) ? next : undefined
}

export function readRememberedLife(storage: StorageLike | undefined): LifeTriple | undefined {
  try {
    const raw = storage?.getItem(LIFE_TRIPLE_KEY)
    if (!raw) return undefined
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const { weatherEnabled, goldEnabled, stocksEnabled } = value as Record<string, unknown>
    if (typeof weatherEnabled !== 'boolean' || typeof goldEnabled !== 'boolean' || typeof stocksEnabled !== 'boolean') return undefined
    return { weatherEnabled, goldEnabled, stocksEnabled }
  } catch {
    return undefined
  }
}

export function writeRememberedLife(storage: StorageLike | undefined, triple: LifeTriple | undefined): void {
  try {
    if (triple) storage?.setItem(LIFE_TRIPLE_KEY, JSON.stringify(triple))
    else storage?.removeItem?.(LIFE_TRIPLE_KEY)
  } catch {
    // Storage may be unavailable; the in-memory copy still works for this session.
  }
}

export type StockParse = { ok: true; stocks: string[] } | { ok: false; error: string }
const STOCK = /^[a-z0-9]{1,10}\.(hk|sh|sz|us)$/

/** Parses the stocks field: up to 3 lower-case `<code>.<market>` symbols separated by commas or spaces. */
export function parseStocks(text: string): StockParse {
  const items = [...new Set(text.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))]
  if (items.some((s) => !STOCK.test(s))) return { ok: false, error: '格式：00700.hk' }
  if (items.length > 3) return { ok: false, error: '最多 3 个' }
  return { ok: true, stocks: items }
}

/** Parses the tool names field: up to 4 names (comma or newline separated), each at most 40 characters. */
export function parseTools(text: string): string[] {
  return [...new Set(text.split(/[,，\n]+/).map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 40)).filter(Boolean))].slice(0, 4)
}

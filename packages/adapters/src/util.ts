/**
 * 读取弱类型 hook 载荷的小型防御性辅助函数。agent 的 hook JSON
 * 在不同版本/渠道间存在差异，因此适配器通过尝试多个候选键来读取字段，
 * 而不是假设固定形态。
 *
 * @module adapters/util
 */

import { parseTokenCount, type TokenPayload } from '@codepulse/shared'

type RateLimitWindowPayload = NonNullable<TokenPayload['rateLimits']>['fiveHour']

/**
 * 返回候选键中找到的第一个非空字符串。
 *
 * @param raw 待读取的记录。
 * @param keys 候选键，按顺序尝试。
 * @returns 首个匹配的字符串；均不匹配时为 `undefined`。
 */
export function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 返回候选键中找到的第一个有限数字。
 *
 * @param raw 待读取的记录。
 * @param keys 候选键，按顺序尝试。
 * @returns 首个匹配的数字；均不匹配时为 `undefined`。
 */
export function pickNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = parseTokenCount(raw[key])
    if (value != null) return value
  }
  return undefined
}

/**
 * 把 unknown 值收窄为普通记录。
 *
 * @param value 任意值（常为嵌套载荷字段）。
 * @returns 记录形态的值；若不是对象则为 `null`。
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

/**
 * 把文本裁剪并截断为隐私友好的预览长度
 * （需求 §5.8 —— CodePulse 默认从不存储完整提示词）。
 *
 * @param text 待预览的文本，可能为 `undefined`。
 * @param max 截断前的最大长度（默认 120）。
 * @returns 裁剪后的预览（截断时带省略号）；无文本时为 `undefined`。
 */
export function preview(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/**
 * 从 Claude/Codex 的 rate limit 结构中读取 5 小时与 7 天额度。
 *
 * Codex 取消 5h 后，周额度常只出现在 `primary`（window_minutes=10080）且
 * `secondary` 为 null；不能再固定把 primary 当 5h、secondary 当周额度。
 */
export function pickRateLimits(raw: Record<string, unknown>): TokenPayload['rateLimits'] {
  const rateLimits = asRecord(raw.rate_limits ?? raw.rateLimits)
  if (!rateLimits) return undefined

  const explicitFive = readRateLimitWindow(rateLimits.five_hour ?? rateLimits.fiveHour)
  const explicitSeven = readRateLimitWindow(rateLimits.seven_day ?? rateLimits.sevenDay)
  if (explicitFive || explicitSeven) {
    return { fiveHour: explicitFive, sevenDay: explicitSeven }
  }

  const primary = readRateLimitWindow(rateLimits.primary)
  const secondary = readRateLimitWindow(rateLimits.secondary)
  if (!primary && !secondary) return undefined

  return classifyPrimarySecondaryWindows(primary, secondary)
}

function classifyPrimarySecondaryWindows(
  primary: RateLimitWindowPayload,
  secondary: RateLimitWindowPayload,
): NonNullable<TokenPayload['rateLimits']> {
  const fiveHour: NonNullable<RateLimitWindowPayload>[] = []
  const sevenDay: NonNullable<RateLimitWindowPayload>[] = []

  for (const window of [primary, secondary]) {
    if (!window) continue
    const kind = classifyWindowKind(window)
    if (kind === 'fiveHour') fiveHour.push(window)
    else if (kind === 'sevenDay') sevenDay.push(window)
  }

  if (primary && secondary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { fiveHour: primary, sevenDay: secondary }
  }
  if (primary && !secondary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { sevenDay: primary }
  }
  if (secondary && !primary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { sevenDay: secondary }
  }

  return {
    fiveHour: fiveHour[0],
    sevenDay: sevenDay[0],
  }
}

/** ≤24h → fiveHour；更长窗口（如 10080 分钟）→ sevenDay。 */
function classifyWindowKind(
  window: NonNullable<RateLimitWindowPayload>,
): 'fiveHour' | 'sevenDay' | 'unknown' {
  const minutes = window.windowMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'unknown'
  if (minutes <= 24 * 60) return 'fiveHour'
  return 'sevenDay'
}

/** Read a quota bucket id from a hook payload or nested rate limit payload. */
export function pickRateLimitId(raw: Record<string, unknown>): string | undefined {
  const rateLimits = asRecord(raw.rate_limits ?? raw.rateLimits)
  return (
    pickString(raw, 'rate_limit_id', 'rateLimitId', 'limit_id', 'limitId') ??
    (rateLimits
      ? pickString(rateLimits, 'rate_limit_id', 'rateLimitId', 'limit_id', 'limitId')
      : undefined)
  )
}

/** Read a quota bucket display name from a hook payload or nested rate limit payload. */
export function pickRateLimitName(raw: Record<string, unknown>): string | undefined {
  const rateLimits = asRecord(raw.rate_limits ?? raw.rateLimits)
  return (
    pickString(raw, 'rate_limit_name', 'rateLimitName', 'limit_name', 'limitName') ??
    (rateLimits
      ? pickString(rateLimits, 'rate_limit_name', 'rateLimitName', 'limit_name', 'limitName')
      : undefined)
  )
}

function readRateLimitWindow(value: unknown): RateLimitWindowPayload {
  const record = asRecord(value)
  if (!record) return undefined
  const usedPercent = pickNumber(record, 'used_percentage', 'usedPercent', 'used_percent')
  const resetsAt = pickNumber(record, 'resets_at', 'resetsAt')
  const windowMinutes = pickNumber(record, 'window_minutes', 'windowMinutes')
  if (usedPercent == null && resetsAt == null && windowMinutes == null) return undefined
  return { usedPercent, resetsAt, windowMinutes }
}

/**
 * 读取弱类型 hook 载荷的小型防御性辅助函数。agent 的 hook JSON
 * 在不同版本/渠道间存在差异，因此适配器通过尝试多个候选键来读取字段，
 * 而不是假设固定形态。
 *
 * @module adapters/util
 */

import type { TokenPayload } from '@codepulse/shared'

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
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
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

/** 从 Claude/Codex 的 rate limit 结构中读取 5 小时与 7 天额度。 */
export function pickRateLimits(raw: Record<string, unknown>): TokenPayload['rateLimits'] {
  const rateLimits = asRecord(raw.rate_limits ?? raw.rateLimits)
  if (!rateLimits) return undefined

  const fiveHour = readRateLimitWindow(
    rateLimits.five_hour ?? rateLimits.fiveHour ?? rateLimits.primary,
  )
  const sevenDay = readRateLimitWindow(
    rateLimits.seven_day ?? rateLimits.sevenDay ?? rateLimits.secondary,
  )

  if (!fiveHour && !sevenDay) return undefined
  return { fiveHour, sevenDay }
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

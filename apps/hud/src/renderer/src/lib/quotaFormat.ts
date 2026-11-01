import type { AgentType, TokenPayload, TokenRateLimitWindow } from '@codepulse/shared'
import { formatTokenPercent } from '@codepulse/shared'
import type { Locale } from './i18n.js'
import { showsFiveHourQuota } from './panelFormat.js'

export function formatQuotaDetail(
  token: TokenPayload | undefined,
  now = Date.now(),
  locale: Locale = 'zh',
  agentType?: AgentType,
): string {
  if (!token) return locale === 'zh' ? '等待命令行同步额度' : 'Waiting for CLI quota sync'
  const rateLimits = token.rateLimits
  const parts = [
    ...(showsFiveHourQuota(agentType)
      ? [formatQuotaWindow(locale === 'zh' ? '5 小时' : '5h', rateLimits?.fiveHour, now, locale)]
      : []),
    formatQuotaWindow(locale === 'zh' ? '每周' : 'Weekly', rateLimits?.sevenDay, now, locale),
  ]
  return parts.join(' / ')
}

function formatQuotaWindow(
  label: string,
  window: TokenRateLimitWindow | undefined,
  now: number,
  locale: Locale,
): string {
  return `${label} ${formatTokenPercent(window?.usedPercent)} · ${formatQuotaReset(
    window?.resetsAt,
    now,
    locale,
  )}`
}

/** Weekly Claude/Codex windows are ≤7 days; anything farther is bad/stale test data. */
const MAX_REASONABLE_RESET_REMAINING_MS = 10 * 24 * 60 * 60_000

export function formatQuotaReset(
  resetsAt: number | undefined,
  now = Date.now(),
  locale: Locale = 'zh',
): string {
  if (!resetsAt) return locale === 'zh' ? '刷新 —' : 'Refresh —'
  const resetAtMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
  const remaining = resetAtMs - now
  if (remaining <= 0) return locale === 'zh' ? '可刷新' : 'Ready'
  // Guard against bogus far-future resets_at (e.g. 2000000000 → "2498 天").
  if (remaining > MAX_REASONABLE_RESET_REMAINING_MS) {
    return locale === 'zh' ? '刷新 —' : 'Refresh —'
  }
  return `${locale === 'zh' ? '刷新' : 'Refresh'} ${formatResetDuration(remaining, locale)}`
}

function formatResetDuration(ms: number, locale: Locale): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (locale === 'zh') {
    if (days > 0) return `${days} 天 ${hours} 小时`
    if (hours > 0) return `${hours} 小时 ${minutes} 分`
    if (minutes > 0) return `${minutes} 分`
    return '<1 分'
  }
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

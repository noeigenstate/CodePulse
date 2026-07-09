/**
 * Token/上下文用量的共享展示辅助函数。放在与框架无关的包中，
 * 以保证后端通知与渲染端 UI 使用一致的措辞和舍入规则。
 *
 * @module shared/token-format
 */
import type { AgentType } from './types/agent.js'
import type { TokenPayload, TokenRateLimitWindow } from './types/token.js'

/** AI CLI 滚动配额窗口的用户可见标签。 */
export const TOKEN_QUOTA_WINDOW_LABEL = '5 小时额度'

export function parseTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined

  const normalized = value.trim().replace(/,/g, '').replace(/_/g, '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km])?(?:\s*(?:tok|tokens?))?$/i)
  if (!match) return undefined

  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined

  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  return Math.round(amount * multiplier)
}

/**
 * 紧凑格式化 token 数量，例如 `512`、`66.9k`、`1.25M`。
 *
 * @param n token 数量（可能未知）。
 * @returns 紧凑的数量字符串；未知时返回 `—`。
 */
export function formatTokenCount(n: number | undefined): string {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
}

export function formatTokenCountWithUnit(n: number | undefined): string {
  const count = formatTokenCount(n)
  return n == null ? count : `${count} token`
}

/**
 * 格式化上下文/token 使用百分比。
 *
 * @param pct 百分比值（可能未知）。
 * @returns 四舍五入后的百分比；未知时返回 `—`。
 */
export function formatTokenPercent(pct: number | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  return `${Math.round(pct)}%`
}

/**
 * 把已知的 token 计数格式化为一行紧凑文本。
 *
 * @param token token 载荷（可能不存在）。
 * @returns 紧凑的用量摘要；无数据时返回 `Token 暂无数据`。
 */
export function formatTokenUsage(token: TokenPayload | undefined): string {
  if (!token) return 'Token 暂无数据'
  const parts: string[] = []
  if (token.input != null) parts.push(`输入 ${formatTokenCountWithUnit(token.input)}`)
  if (token.cachedInput != null) parts.push(`缓存 ${formatTokenCountWithUnit(token.cachedInput)}`)
  if (token.output != null) parts.push(`输出 ${formatTokenCountWithUnit(token.output)}`)
  if (token.reasoningOutput != null) {
    parts.push(`推理 ${formatTokenCountWithUnit(token.reasoningOutput)}`)
  }
  if (token.total != null) parts.push(`总计 ${formatTokenCountWithUnit(token.total)}`)
  return parts.length > 0 ? parts.join(' / ') : 'Token 暂无数据'
}

export function formatTokenQuotaDetail(token: TokenPayload | undefined, now = Date.now()): string {
  if (!token) return '等待 CLI 同步额度'
  const rateLimits = token?.rateLimits
  return [
    formatTokenQuotaWindow('5h', rateLimits?.fiveHour, now),
    formatTokenQuotaWindow('每周', rateLimits?.sevenDay, now),
  ].join(' / ')
}

function formatTokenQuotaWindow(
  label: string,
  window: TokenRateLimitWindow | undefined,
  now: number,
): string {
  return `${label} ${formatTokenPercent(window?.usedPercent)} · ${formatTokenQuotaReset(
    window?.resetsAt,
    now,
  )}`
}

export function formatTokenQuotaReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt) return '刷新 —'
  const resetAtMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
  const remaining = resetAtMs - now
  if (remaining <= 0) return '可刷新'
  return `刷新 ${formatResetDuration(remaining)}`
}

function formatResetDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m`
  return '<1m'
}

/**
 * 构造高用量通知中使用的标准配额/上下文提示文案。
 *
 * @param agent 产生该测量值的 agent。
 * @param token 最新的 token 载荷。
 * @returns 简短的通知正文。
 */
export function formatTokenQuotaNotice(
  agent: AgentType,
  token: TokenPayload,
  now = Date.now(),
): string {
  const pct = formatTokenPercent(token.contextUsedPercent)
  const quotaText = formatTokenQuotaDetail(token, now)
  const sourceNote =
    agent === 'codex'
      ? 'Codex token 为估算值'
      : agent === 'grok'
        ? token.accuracy === 'estimated'
          ? 'Grok token 为估算值'
          : 'Grok token 来自 hook'
        : token.accuracy === 'estimated'
          ? 'Claude token 为估算值'
          : 'Claude token 来自 status line'
  return `Token/context 已使用 ${pct}。${quotaText}，窗口以对应 CLI 的官方重置时间为准，${sourceNote}。`
}

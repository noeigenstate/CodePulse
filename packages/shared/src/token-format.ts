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

/**
 * Parses token count.
 * @param value Human-readable token count such as `1.2M` or `32k`.
 * @returns Parsed token count, or `undefined` for invalid input.
 */
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
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
  return `${(n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, '')}B`
}

/**
 * Formats token count with unit.
 * @param n Token count to format.
 * @returns Compact token count and the unit used to display it.
 */
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

/**
 * 把 token 用量渲染成 Codex 官方 usage 行的格式：
 * `usage: total=3,666,704 input=3,268,650 (+ 66,327,168 cached) output=190,000 (reasoning 207,774)`
 *
 * 数字使用精确千分位（与 Codex 一致），缺失的分段直接省略，
 * 不展示任何周/时段额度信息。
 *
 * @param token token 载荷（可能不存在）。
 * @returns Codex 风格 usage 行；无数据时各分段省略，仅保留 `usage:` 前缀。
 */
export function formatTokenUsageLine(token: TokenPayload | undefined): string {
  const parts: string[] = []
  if (token?.total != null) parts.push(`total=${formatTokenExact(token.total)}`)
  if (token?.input != null) parts.push(`input=${formatTokenExact(token.input)}`)
  if (token?.cachedInput != null && token.cachedInput > 0) {
    parts.push(`(+ ${formatTokenExact(token.cachedInput)} cached)`)
  }
  if (token?.output != null) {
    const reasoning =
      token.reasoningOutput != null && token.reasoningOutput > 0
        ? ` (reasoning ${formatTokenExact(token.reasoningOutput)})`
        : ''
    parts.push(`output=${formatTokenExact(token.output)}${reasoning}`)
  }
  return parts.length > 0 ? `usage: ${parts.join(' ')}` : 'usage: —'
}

/**
 * 精确 token 计数的千分位格式化（Codex 官方 usage 行风格）。
 * @param n token 数量。
 * @returns 带千分位分隔符的数字字符串。
 */
function formatTokenExact(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

/** Codex / Grok 仅周额度；Claude Code 保留 5 小时 + 周额度。

 * @param agent CLI agent family.
 * @returns Whether the agent exposes its five-hour quota window.
*/
function showsFiveHourQuota(agent: AgentType | undefined): boolean {
  return agent === 'claude_code'
}

/**
 * Formats token quota detail.
 * @param token Token payload to process.
 * @param now Current epoch timestamp in milliseconds.
 * @param agent Agent runtime state.
 * @returns Human-readable quota detail, or `undefined` when quota is unavailable.
 */
export function formatTokenQuotaDetail(
  token: TokenPayload | undefined,
  now = Date.now(),
  agent?: AgentType,
): string {
  if (!token) return '等待 CLI 同步额度'
  const rateLimits = token?.rateLimits
  const parts = [
    ...(showsFiveHourQuota(agent) ? [formatTokenQuotaWindow('5h', rateLimits?.fiveHour, now)] : []),
    formatTokenQuotaWindow('每周', rateLimits?.sevenDay, now),
  ]
  return parts.join(' / ')
}

/**
 * Formats token quota window.
 * @param label Localized quota-window label.
 * @param window Quota window to process.
 * @param now Current epoch timestamp in milliseconds.
 * @returns Formatted quota-window description.
 */
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

/**
 * Formats token quota reset.
 * @param resetsAt Quota reset timestamp in seconds or milliseconds.
 * @param now Current epoch timestamp in milliseconds.
 * @returns Human-readable reset countdown, or `undefined` for implausible timestamps.
 */
export function formatTokenQuotaReset(resetsAt: number | undefined, now = Date.now()): string {
  if (!resetsAt) return '刷新 —'
  const resetAtMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
  const remaining = resetAtMs - now
  if (remaining <= 0) return '可刷新'
  return `刷新 ${formatResetDuration(remaining)}`
}

/**
 * Formats reset duration.
 * @param ms Duration in milliseconds.
 * @returns Compact localized duration.
 */
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
 * @param now 用于计算重置倒计时的当前时间戳。
 * @returns 简短的通知正文。

 */
export function formatTokenQuotaNotice(
  agent: AgentType,
  token: TokenPayload,
  now = Date.now(),
): string {
  const pct = formatTokenPercent(token.contextUsedPercent)
  const quotaText = formatTokenQuotaDetail(token, now, agent)
  const sourceNote =
    agent === 'codex'
      ? 'Codex token 为估算值'
      : agent === 'grok'
        ? (token.contextAccuracy ?? token.accuracy) === 'estimated'
          ? 'Grok token 为估算值'
          : 'Grok token 来自 hook'
        : (token.contextAccuracy ?? token.accuracy) === 'estimated'
          ? 'Claude token 为估算值'
          : 'Claude token 来自 status line'
  return `Token/context 已使用 ${pct}。${quotaText}，窗口以对应 CLI 的官方重置时间为准，${sourceNote}。`
}

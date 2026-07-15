/**
 * Claude 账号额度：statusline 缓存 + 可选 OAuth usage 拉取。
 * 与 local-server 的 claude-quota.ts 行为对齐（hooks 为纯 JS，独立实现）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CACHE_REL = ['.codepulse', 'claude-quota.json']
/** 缓存仍可用于展示的最长时间（statusline 在 CLI 未带 rate_limits 时回填）。 */
const CACHE_MAX_AGE_MS = 6 * 60 * 60_000
const OAUTH_BETA = 'oauth-2025-04-20'

export function claudeQuotaCachePath(home = homedir()) {
  return join(home, ...CACHE_REL)
}

/**
 * @returns {{ rate_limits?: object, rate_limit_id?: string, rate_limit_name?: string, updatedAt?: number } | null}
 */
export function readClaudeQuotaCache(home = homedir()) {
  try {
    const raw = JSON.parse(readFileSync(claudeQuotaCachePath(home), 'utf8'))
    if (!raw || typeof raw !== 'object') return null
    const updatedAt = Number(raw.updatedAt) || 0
    if (updatedAt > 0 && Date.now() - updatedAt > CACHE_MAX_AGE_MS) return null
    if (!raw.rate_limits || typeof raw.rate_limits !== 'object') return null
    return raw
  } catch {
    return null
  }
}

/**
 * @param {{ rate_limits: object, rate_limit_id?: string, rate_limit_name?: string }} payload
 */
export function writeClaudeQuotaCache(payload, home = homedir()) {
  try {
    const dir = join(home, '.codepulse')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      claudeQuotaCachePath(home),
      `${JSON.stringify(
        {
          updatedAt: Date.now(),
          rate_limits: payload.rate_limits,
          ...(payload.rate_limit_id ? { rate_limit_id: payload.rate_limit_id } : {}),
          ...(payload.rate_limit_name ? { rate_limit_name: payload.rate_limit_name } : {}),
          source: payload.source ?? 'statusline',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch {
    // ignore cache write failures
  }
}

/**
 * 从 statusline stdin 或 OAuth 响应中规范化 rate_limits（snake_case 供 hook 转发）。
 * @param {unknown} raw
 * @returns {object | null}
 */
export function normalizeClaudeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return null
  const src = /** @type {Record<string, unknown>} */ (raw)

  const five = normalizeWindow(src.five_hour ?? src.fiveHour ?? src['five-hour'])
  const seven =
    normalizeWindow(src.seven_day ?? src.sevenDay ?? src['seven-day']) ??
    normalizeWindow(src.seven_day_opus ?? src.sevenDayOpus) ??
    normalizeWindow(src.seven_day_sonnet ?? src.sevenDaySonnet) ??
    normalizeWindow(src.seven_day_oauth_apps ?? src.sevenDayOauthApps)

  if (!five && !seven) return null
  return {
    ...(five ? { five_hour: five } : {}),
    ...(seven ? { seven_day: seven } : {}),
  }
}

/**
 * @param {unknown} value
 * @returns {{ used_percent: number, resets_at?: number, window_minutes?: number } | null}
 */
function normalizeWindow(value) {
  if (!value || typeof value !== 'object') return null
  const w = /** @type {Record<string, unknown>} */ (value)
  // Prefer explicit percent fields; only scale bare `utilization` when it looks like 0–1.
  let used = numberish(w.used_percentage ?? w.usedPercent ?? w.used_percent)
  if (used == null) {
    const utilization = numberish(w.utilization)
    if (utilization != null) {
      used = utilization >= 0 && utilization <= 1 ? utilization * 100 : utilization
    }
  }
  const resetsAt = parseResetsAt(w.resets_at ?? w.resetsAt)
  const windowMinutes = numberish(w.window_minutes ?? w.windowMinutes)
  if (used == null && resetsAt == null && windowMinutes == null) return null
  return {
    ...(used != null ? { used_percent: Math.min(100, Math.max(0, used)) } : {}),
    ...(resetsAt != null ? { resets_at: resetsAt } : {}),
    ...(windowMinutes != null ? { window_minutes: windowMinutes } : {}),
  }
}

function numberish(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function parseResetsAt(value) {
  let seconds
  if (typeof value === 'number' && Number.isFinite(value)) {
    // ms → s
    seconds = value > 1_000_000_000_000 ? Math.floor(value / 1000) : value
  } else if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value)
    if (Number.isFinite(ms)) seconds = Math.floor(ms / 1000)
    else {
      const n = Number(value)
      if (Number.isFinite(n)) seconds = n > 1_000_000_000_000 ? Math.floor(n / 1000) : n
    }
  }
  if (seconds == null) return undefined
  // Drop absurd far-future placeholders (e.g. 2000000000 → "2498 天").
  if (seconds * 1000 - Date.now() > 10 * 24 * 60 * 60_000) return undefined
  return seconds
}

/**
 * 尽力从 Anthropic OAuth usage 拉取额度（部分地区/账号会 403）。
 * @param {{ timeoutMs?: number, home?: string }} [options]
 * @returns {Promise<{ rate_limits: object, rate_limit_id?: string, rate_limit_name?: string } | null>}
 */
export async function fetchClaudeOauthUsage(options = {}) {
  const timeoutMs = options.timeoutMs ?? 1200
  const home = options.home ?? homedir()
  let accessToken
  let subscriptionType
  try {
    const cred = JSON.parse(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'))
    accessToken = cred?.claudeAiOauth?.accessToken
    subscriptionType = cred?.claudeAiOauth?.subscriptionType
  } catch {
    return null
  }
  if (typeof accessToken !== 'string' || accessToken.length < 20) return null

  const base = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') || 'https://api.anthropic.com'
  const url = `${base}/api/oauth/usage`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'anthropic-beta': OAUTH_BETA,
        'User-Agent': 'claude-cli/2.1.209 (external, codepulse)',
      },
      signal: controller.signal,
    })
    if (!res.ok) return null
    const data = await res.json()
    const rate_limits = normalizeClaudeRateLimits(data)
    if (!rate_limits) return null
    return {
      rate_limits,
      rate_limit_id: 'claude',
      rate_limit_name:
        typeof subscriptionType === 'string' && subscriptionType
          ? `Claude ${subscriptionType}`
          : 'Claude',
      source: 'oauth',
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析 statusline 载荷中的额度：stdin → OAuth → 磁盘缓存。
 * @param {Record<string, unknown>} data
 * @param {{ timeoutMs?: number, home?: string }} [options]
 */
export async function resolveClaudeRateLimitsForStatusline(data, options = {}) {
  const fromStdin = normalizeClaudeRateLimits(data?.rate_limits ?? data?.rateLimits)
  if (fromStdin) {
    writeClaudeQuotaCache(
      {
        rate_limits: fromStdin,
        rate_limit_id: typeof data?.rate_limit_id === 'string' ? data.rate_limit_id : 'claude',
        rate_limit_name:
          typeof data?.rate_limit_name === 'string' ? data.rate_limit_name : undefined,
        source: 'statusline',
      },
      options.home,
    )
    return {
      rate_limits: fromStdin,
      rate_limit_id: typeof data?.rate_limit_id === 'string' ? data.rate_limit_id : undefined,
      rate_limit_name: typeof data?.rate_limit_name === 'string' ? data.rate_limit_name : undefined,
    }
  }

  const oauth = await fetchClaudeOauthUsage({
    timeoutMs: options.timeoutMs ?? 900,
    home: options.home,
  })
  if (oauth?.rate_limits) {
    writeClaudeQuotaCache(oauth, options.home)
    return oauth
  }

  const cached = readClaudeQuotaCache(options.home)
  if (cached?.rate_limits) {
    return {
      rate_limits: cached.rate_limits,
      rate_limit_id: cached.rate_limit_id,
      rate_limit_name: cached.rate_limit_name,
    }
  }
  return null
}

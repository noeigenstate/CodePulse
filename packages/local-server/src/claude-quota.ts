/**
 * Claude 账号额度：OAuth usage 拉取 + 本地缓存（statusline / session-sync 共用策略）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenPayload } from '@codepulse/shared'

const CACHE_MAX_AGE_MS = 6 * 60 * 60_000
const OAUTH_BETA = 'oauth-2025-04-20'

export interface ClaudeQuotaSnapshot {
  rateLimits: NonNullable<TokenPayload['rateLimits']>
  rateLimitId?: string
  rateLimitName?: string
  updatedAt: number
  source: 'statusline' | 'oauth' | 'cache'
}

export function claudeQuotaCachePath(home = homedir()): string {
  return join(home, '.codepulse', 'claude-quota.json')
}

export async function readClaudeQuotaCache(
  home = homedir(),
  now = Date.now(),
): Promise<ClaudeQuotaSnapshot | undefined> {
  try {
    const raw = JSON.parse(await readFile(claudeQuotaCachePath(home), 'utf8')) as Record<
      string,
      unknown
    >
    const updatedAt = typeof raw.updatedAt === 'number' ? raw.updatedAt : 0
    if (updatedAt > 0 && now - updatedAt > CACHE_MAX_AGE_MS) return undefined
    const rateLimits = normalizeClaudeRateLimitsPayload(raw.rate_limits ?? raw.rateLimits)
    if (!rateLimits) return undefined
    return {
      rateLimits,
      rateLimitId: typeof raw.rate_limit_id === 'string' ? raw.rate_limit_id : undefined,
      rateLimitName: typeof raw.rate_limit_name === 'string' ? raw.rate_limit_name : undefined,
      updatedAt,
      source: 'cache',
    }
  } catch {
    return undefined
  }
}

export async function writeClaudeQuotaCache(
  snapshot: Omit<ClaudeQuotaSnapshot, 'updatedAt' | 'source'> & {
    source?: ClaudeQuotaSnapshot['source']
  },
  home = homedir(),
  now = Date.now(),
): Promise<void> {
  try {
    await mkdir(join(home, '.codepulse'), { recursive: true })
    await writeFile(
      claudeQuotaCachePath(home),
      `${JSON.stringify(
        {
          updatedAt: now,
          rate_limits: toSnakeRateLimits(snapshot.rateLimits),
          ...(snapshot.rateLimitId ? { rate_limit_id: snapshot.rateLimitId } : {}),
          ...(snapshot.rateLimitName ? { rate_limit_name: snapshot.rateLimitName } : {}),
          source: snapshot.source ?? 'statusline',
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
  } catch {
    // ignore
  }
}

/** 主动获取 Claude 账号额度：OAuth → 磁盘缓存。 */
export async function resolveClaudeAccountQuota(options?: {
  home?: string
  now?: () => number
  timeoutMs?: number
}): Promise<ClaudeQuotaSnapshot | undefined> {
  const home = options?.home ?? homedir()
  const now = options?.now?.() ?? Date.now()
  const oauth = await fetchClaudeOauthUsage({
    home,
    timeoutMs: options?.timeoutMs ?? 1_500,
  })
  if (oauth) {
    await writeClaudeQuotaCache({ ...oauth, source: 'oauth' }, home, now)
    return { ...oauth, updatedAt: now, source: 'oauth' }
  }
  return readClaudeQuotaCache(home, now)
}

export async function fetchClaudeOauthUsage(options?: {
  home?: string
  timeoutMs?: number
}): Promise<Omit<ClaudeQuotaSnapshot, 'updatedAt' | 'source'> | undefined> {
  const home = options?.home ?? homedir()
  const timeoutMs = options?.timeoutMs ?? 1_500
  let accessToken: string | undefined
  let subscriptionType: string | undefined
  try {
    const cred = JSON.parse(await readFile(join(home, '.claude', '.credentials.json'), 'utf8')) as {
      claudeAiOauth?: { accessToken?: string; subscriptionType?: string }
    }
    accessToken = cred.claudeAiOauth?.accessToken
    subscriptionType = cred.claudeAiOauth?.subscriptionType
  } catch {
    return undefined
  }
  if (!accessToken || accessToken.length < 20) return undefined

  const base = process.env.ANTHROPIC_BASE_URL?.replace(/\/$/, '') || 'https://api.anthropic.com'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base}/api/oauth/usage`, {
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
    if (!res.ok) return undefined
    const data = (await res.json()) as unknown
    const rateLimits = normalizeClaudeRateLimitsPayload(data)
    if (!rateLimits) return undefined
    return {
      rateLimits,
      rateLimitId: 'claude',
      rateLimitName: subscriptionType ? `Claude ${subscriptionType}` : 'Claude',
    }
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

export function mergeClaudeContextWithQuota(
  context: TokenPayload | undefined,
  quota: ClaudeQuotaSnapshot | undefined,
): TokenPayload {
  const base = context ?? { accuracy: 'unknown' as const }
  if (!quota?.rateLimits) return base
  return {
    ...base,
    rateLimits: quota.rateLimits,
    rateLimitId: quota.rateLimitId ?? base.rateLimitId ?? 'claude',
    rateLimitName: quota.rateLimitName ?? base.rateLimitName,
    accuracy: base.accuracy === 'exact' ? 'exact' : 'estimated',
  }
}

export function normalizeClaudeRateLimitsPayload(
  raw: unknown,
): NonNullable<TokenPayload['rateLimits']> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = raw as Record<string, unknown>
  const five = normalizeWindow(src.five_hour ?? src.fiveHour)
  const seven =
    normalizeWindow(src.seven_day ?? src.sevenDay) ??
    normalizeWindow(src.seven_day_opus ?? src.sevenDayOpus) ??
    normalizeWindow(src.seven_day_sonnet ?? src.sevenDaySonnet) ??
    normalizeWindow(src.seven_day_oauth_apps ?? src.sevenDayOauthApps)
  if (!five && !seven) return undefined
  return { fiveHour: five, sevenDay: seven }
}

function normalizeWindow(
  value: unknown,
): NonNullable<TokenPayload['rateLimits']>['fiveHour'] | undefined {
  if (!value || typeof value !== 'object') return undefined
  const w = value as Record<string, unknown>
  let used = numberish(w.used_percentage ?? w.usedPercent ?? w.used_percent)
  if (used == null) {
    const utilization = numberish(w.utilization)
    if (utilization != null) {
      used = utilization >= 0 && utilization <= 1 ? utilization * 100 : utilization
    }
  }
  const resetsAt = parseResetsAt(w.resets_at ?? w.resetsAt)
  const windowMinutes = numberish(w.window_minutes ?? w.windowMinutes)
  if (used == null && resetsAt == null && windowMinutes == null) return undefined
  return {
    ...(used != null ? { usedPercent: Math.min(100, Math.max(0, used)) } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowMinutes != null ? { windowMinutes } : {}),
  }
}

function toSnakeRateLimits(rateLimits: NonNullable<TokenPayload['rateLimits']>): unknown {
  const map = (w: NonNullable<TokenPayload['rateLimits']>['fiveHour'] | undefined) =>
    w
      ? {
          ...(w.usedPercent != null ? { used_percent: w.usedPercent } : {}),
          ...(w.resetsAt != null ? { resets_at: w.resetsAt } : {}),
          ...(w.windowMinutes != null ? { window_minutes: w.windowMinutes } : {}),
        }
      : undefined
  return {
    ...(rateLimits.fiveHour ? { five_hour: map(rateLimits.fiveHour) } : {}),
    ...(rateLimits.sevenDay ? { seven_day: map(rateLimits.sevenDay) } : {}),
  }
}

function numberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function parseResetsAt(value: unknown): number | undefined {
  let seconds: number | undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
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

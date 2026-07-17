/**
 * Resolves Kimi Code account quotas from the same managed usage endpoint used
 * by the CLI's `/status` panel.
 *
 * @module local-server/kimi-quota
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { TokenPayload, TokenRateLimitWindow } from '@codepulse/shared'

const CACHE_MAX_AGE_MS = 6 * 60 * 60_000
const DEFAULT_USAGE_BASE_URL = 'https://api.kimi.com/coding/v1'

/** A sanitized Kimi quota snapshot that never contains OAuth credentials. */
export interface KimiQuotaSnapshot {
  rateLimits: NonNullable<TokenPayload['rateLimits']>
  updatedAt: number
  source: 'api' | 'cache'
}

/** Returns the on-disk path used for the sanitized Kimi quota cache. */
export function kimiQuotaCachePath(home = homedir()): string {
  return join(home, '.codepulse', 'kimi-quota.json')
}

/**
 * Fetches current Kimi quota, falling back to the latest non-expired cache.
 *
 * Kimi CLI remains the owner of refreshing and writing its OAuth credentials.
 * CodePulse only reads the current access token, which avoids racing the CLI's
 * atomic credential replacement.
 */
export async function resolveKimiAccountQuota(options?: {
  kimiHome?: string
  userHome?: string
  now?: () => number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<KimiQuotaSnapshot | undefined> {
  const userHome = options?.userHome ?? homedir()
  const now = options?.now?.() ?? Date.now()
  const quota = await fetchKimiManagedUsage({
    kimiHome: options?.kimiHome,
    timeoutMs: options?.timeoutMs,
    fetchImpl: options?.fetchImpl,
  })
  if (quota) {
    const snapshot: KimiQuotaSnapshot = { rateLimits: quota, updatedAt: now, source: 'api' }
    await writeKimiQuotaCache(snapshot, userHome)
    return snapshot
  }
  return readKimiQuotaCache(userHome, now)
}

/** Fetches and normalizes the managed `/usages` response. */
export async function fetchKimiManagedUsage(options?: {
  kimiHome?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<NonNullable<TokenPayload['rateLimits']> | undefined> {
  const kimiHome = options?.kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
  let accessToken: string | undefined
  try {
    const credentials = JSON.parse(
      await readFile(join(kimiHome, 'credentials', 'kimi-code.json'), 'utf8'),
    ) as Record<string, unknown>
    accessToken = stringValue(credentials.access_token)
  } catch {
    return undefined
  }
  if (!accessToken || accessToken.length < 20) return undefined

  const baseUrl = (process.env.KIMI_CODE_BASE_URL ?? DEFAULT_USAGE_BASE_URL).replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options?.timeoutMs ?? 1_500)
  try {
    const response = await (options?.fetchImpl ?? fetch)(`${baseUrl}/usages`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    return normalizeKimiManagedUsage(await response.json())
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Maps Kimi's managed usage payload to CodePulse's five-hour and weekly windows.
 */
export function normalizeKimiManagedUsage(
  payload: unknown,
): NonNullable<TokenPayload['rateLimits']> | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  const sevenDay = normalizeUsageWindow(record.usage, 7 * 24 * 60)
  let fiveHour: TokenRateLimitWindow | undefined

  if (Array.isArray(record.limits)) {
    for (const item of record.limits) {
      if (!item || typeof item !== 'object') continue
      const limit = item as Record<string, unknown>
      const window = asRecord(limit.window)
      const windowMinutes = durationMinutes(window)
      if (windowMinutes !== 5 * 60) continue
      fiveHour = normalizeUsageWindow(limit.detail ?? limit, windowMinutes)
      if (fiveHour) break
    }
  }

  if (!fiveHour && !sevenDay) return undefined
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

/** Reads a recent sanitized snapshot from CodePulse's own cache. */
export async function readKimiQuotaCache(
  home = homedir(),
  now = Date.now(),
): Promise<KimiQuotaSnapshot | undefined> {
  try {
    const record = JSON.parse(await readFile(kimiQuotaCachePath(home), 'utf8')) as Record<
      string,
      unknown
    >
    const updatedAt = numberValue(record.updatedAt) ?? 0
    if (updatedAt <= 0 || now - updatedAt > CACHE_MAX_AGE_MS) return undefined
    const rateLimits = normalizeCachedRateLimits(record.rateLimits)
    return rateLimits ? { rateLimits, updatedAt, source: 'cache' } : undefined
  } catch {
    return undefined
  }
}

/** Writes only normalized quota percentages and reset timestamps. */
async function writeKimiQuotaCache(snapshot: KimiQuotaSnapshot, home: string): Promise<void> {
  try {
    await mkdir(join(home, '.codepulse'), { recursive: true })
    await writeFile(
      kimiQuotaCachePath(home),
      `${JSON.stringify({ updatedAt: snapshot.updatedAt, rateLimits: snapshot.rateLimits }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // A read-only profile must not interrupt session synchronization.
  }
}

/** Converts one API usage row into a percentage and reset timestamp. */
function normalizeUsageWindow(
  value: unknown,
  windowMinutes: number,
): TokenRateLimitWindow | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const limit = numberValue(record.limit)
  let used = numberValue(record.used)
  if (used == null && limit != null) {
    const remaining = numberValue(record.remaining)
    if (remaining != null) used = limit - remaining
  }
  const usedPercent = limit != null && limit > 0 && used != null ? (used / limit) * 100 : undefined
  const resetsAt = parseResetTime(
    record.resetTime ?? record.reset_time ?? record.resetAt ?? record.reset_at,
  )
  if (usedPercent == null && resetsAt == null) return undefined
  return {
    ...(usedPercent != null ? { usedPercent: Math.min(100, Math.max(0, usedPercent)) } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
    windowMinutes,
  }
}

/** Normalizes a previously sanitized cache payload. */
function normalizeCachedRateLimits(
  value: unknown,
): NonNullable<TokenPayload['rateLimits']> | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const fiveHour = normalizeCachedWindow(record.fiveHour)
  const sevenDay = normalizeCachedWindow(record.sevenDay)
  return fiveHour || sevenDay
    ? { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
    : undefined
}

/** Validates one cached rate-limit window. */
function normalizeCachedWindow(value: unknown): TokenRateLimitWindow | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const usedPercent = numberValue(record.usedPercent)
  const resetsAt = numberValue(record.resetsAt)
  const windowMinutes = numberValue(record.windowMinutes)
  if (usedPercent == null && resetsAt == null && windowMinutes == null) return undefined
  return {
    ...(usedPercent != null ? { usedPercent: Math.min(100, Math.max(0, usedPercent)) } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowMinutes != null ? { windowMinutes } : {}),
  }
}

/** Converts Kimi's duration/unit pair to minutes. */
function durationMinutes(window: Record<string, unknown> | undefined): number | undefined {
  if (!window) return undefined
  const duration = numberValue(window.duration)
  const unit = stringValue(window.timeUnit ?? window.time_unit)?.toUpperCase()
  if (duration == null || duration <= 0 || !unit) return undefined
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 24 * 60
  if (unit.includes('SECOND')) return duration / 60
  return undefined
}

/** Parses an ISO reset timestamp to epoch seconds. */
function parseResetTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value)
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function numberValue(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(number) ? number : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

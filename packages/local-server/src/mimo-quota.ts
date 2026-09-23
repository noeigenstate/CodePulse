/**
 * Resolves Xiaomi MiMo Token Plan quota for OpenCode sessions.
 *
 * Token Plan keys (`tp-…`) only authenticate the inference gateway; plan usage
 * is exposed by the platform console API behind the Xiaomi SSO session cookie
 * (`serviceToken` + `userId`). The desktop shell owns that login and hands the
 * cookie in through a provider, so this module never persists credentials.
 *
 * @module local-server/mimo-quota
 */
import type { TokenPayload } from '@codepulse/shared'

export const MIMO_PLATFORM_API_BASE = 'https://platform.xiaomimimo.com/api/v1'
/** Token Plan credits renew monthly; declaring it lets far-off resets pass the weekly guard. */
const MIMO_PLAN_WINDOW_MINUTES = 31 * 24 * 60

/** A sanitized MiMo quota snapshot that never contains the console cookie. */
export interface MimoQuotaSnapshot {
  /** Plan credits for the current billing period, stored in the long-window slot. */
  rateLimits: NonNullable<TokenPayload['rateLimits']>
  /** Plan code reported by the console (`standard`, `pro`, …), when known. */
  planCode?: string
  updatedAt: number
}

/** Request for the console cookie; `refresh` asks the owner to renew an expired login. */
export interface MimoCookieRequest {
  refresh: boolean
  /** SSO URL from the console's 401 envelope; loading it renews `serviceToken`. */
  loginUrl?: string
}

/** Supplies the platform console cookie header, or `undefined` when logged out. */
export type MimoCookieProvider = (request: MimoCookieRequest) => Promise<string | undefined>

/** Raised when the console rejects the cookie; carries the SSO URL when provided. */
class MimoAuthError extends Error {
  constructor(readonly loginUrl?: string) {
    super('MiMo console login expired')
  }
}

/**
 * Fetches current Token Plan usage, renewing the login once when it has expired.
 *
 * @param options Cookie provider and transport overrides.
 * @returns Quota snapshot, or `undefined` when logged out or the console is unreachable.
 */
export async function resolveMimoTokenPlanQuota(options: {
  cookieProvider: MimoCookieProvider
  now?: () => number
  timeoutMs?: number
  fetchImpl?: typeof fetch
}): Promise<MimoQuotaSnapshot | undefined> {
  const cookie = await options.cookieProvider({ refresh: false })
  if (!cookie) return undefined
  try {
    return await fetchMimoTokenPlanQuota(cookie, options)
  } catch (err) {
    if (!(err instanceof MimoAuthError)) return undefined
    const renewed = await options
      .cookieProvider({ refresh: true, loginUrl: err.loginUrl })
      .catch(() => undefined)
    if (!renewed || renewed === cookie) return undefined
    return fetchMimoTokenPlanQuota(renewed, options).catch(() => undefined)
  }
}

/**
 * Reads `tokenPlan/usage` (credits) and `tokenPlan/detail` (period end) with one cookie.
 *
 * @param cookie Console cookie header.
 * @param options Transport overrides.
 * @returns Normalized snapshot, or `undefined` when the response carries no plan window.
 * @throws MimoAuthError when the console rejects the cookie.
 */
async function fetchMimoTokenPlanQuota(
  cookie: string,
  options: { now?: () => number; timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<MimoQuotaSnapshot | undefined> {
  const [usage, detail] = await Promise.all([
    readConsoleJson('tokenPlan/usage', cookie, options),
    // The reset time is an enhancement; usage alone still draws the bar.
    readConsoleJson('tokenPlan/detail', cookie, options).catch((err: unknown) => {
      if (err instanceof MimoAuthError) throw err
      return undefined
    }),
  ])
  const usedPercent = parseMimoPlanUsedPercent(usage)
  if (usedPercent === undefined) return undefined
  const plan = parseMimoPlanDetail(detail)
  return {
    rateLimits: {
      sevenDay: {
        usedPercent,
        windowMinutes: MIMO_PLAN_WINDOW_MINUTES,
        ...(plan.resetsAt !== undefined ? { resetsAt: plan.resetsAt } : {}),
      },
    },
    planCode: plan.planCode,
    updatedAt: options.now?.() ?? Date.now(),
  }
}

/**
 * GETs one console endpoint and unwraps its `{ code, data }` envelope.
 *
 * @param path Endpoint path under {@link MIMO_PLATFORM_API_BASE}.
 * @param cookie Console cookie header.
 * @param options Transport overrides.
 * @returns Parsed JSON body.
 * @throws MimoAuthError on HTTP or envelope 401/403 and redirects to login.
 */
async function readConsoleJson(
  path: string,
  cookie: string,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const response = await (options.fetchImpl ?? fetch)(`${MIMO_PLATFORM_API_BASE}/${path}`, {
      method: 'GET',
      headers: { Cookie: cookie, Accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) throw new MimoAuthError()
    const body: unknown = await response.json().catch(() => undefined)
    const envelope = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const code = envelope.code === undefined ? undefined : String(envelope.code)
    if (response.status === 401 || response.status === 403 || code === '401' || code === '403') {
      throw new MimoAuthError(typeof envelope.loginUrl === 'string' ? envelope.loginUrl : undefined)
    }
    if (!response.ok || (code !== undefined && code !== '0')) {
      throw new Error(`MiMo ${path} failed: HTTP ${response.status}, code ${code ?? '-'}`)
    }
    return body
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extracts the plan-credit used percentage from a `tokenPlan/usage` response.
 *
 * Shape: `{ code: 0, data: { monthUsage: { items: [{ name, used, limit, percent }] } } }`.
 * The plan row is `month_total_token` / `plan_total_token`; compensation credits
 * are a separate pool and are not folded into the plan bar.
 *
 * @param body Parsed response body.
 * @returns Used percentage (0–100), or `undefined` when no plan row is present.
 */
export function parseMimoPlanUsedPercent(body: unknown): number | undefined {
  const root = unwrapData(body)
  if (!root) return undefined
  let items: unknown[] | undefined
  for (const bucket of [root.monthUsage, root.usage, root]) {
    if (
      bucket &&
      typeof bucket === 'object' &&
      Array.isArray((bucket as { items?: unknown }).items)
    ) {
      items = (bucket as { items: unknown[] }).items
      break
    }
  }
  if (!items) return undefined
  const rows = items.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object',
  )
  const plan =
    rows.find((row) => row.name === 'month_total_token' || row.name === 'plan_total_token') ??
    rows.find((row) => row.name !== 'compensation_total_token')
  if (!plan) return undefined
  const limit = numberValue(plan.limit ?? plan.total)
  const used = numberValue(plan.used)
  let percent: number | undefined
  // Prefer used/limit; `percent` is a 0–1 fraction that loses precision near 1%.
  if (limit !== undefined && limit > 0 && used !== undefined && used >= 0) {
    percent = (used / limit) * 100
  } else {
    const fraction = numberValue(plan.percent)
    if (fraction !== undefined && fraction >= 0) percent = fraction * 100
  }
  return percent === undefined ? undefined : Math.min(100, Math.max(0, percent))
}

/**
 * Reads the plan code and period end from a `tokenPlan/detail` response.
 *
 * `currentPeriodEnd` is a bare `yyyy-MM-dd HH:mm:ss` shown in Beijing time by
 * the console, so it is interpreted as +08:00.
 *
 * @param body Parsed response body, or `undefined` when the request failed.
 * @returns Plan code and reset time in epoch seconds, when present.
 */
export function parseMimoPlanDetail(body: unknown): { planCode?: string; resetsAt?: number } {
  const root = unwrapData(body)
  if (!root) return {}
  const planCode =
    typeof root.planCode === 'string' && root.planCode.trim() ? root.planCode.trim() : undefined
  const raw = typeof root.currentPeriodEnd === 'string' ? root.currentPeriodEnd.trim() : ''
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/.exec(raw)
  const ms = match ? Date.parse(`${match[1]}T${match[2]}${match[3] ?? ':00'}+08:00`) : NaN
  return {
    planCode,
    resetsAt: Number.isFinite(ms) ? Math.round(ms / 1000) : undefined,
  }
}

/**
 * Returns the `data` object of a console envelope, or the body itself.
 * @param body Parsed response body.
 * @returns Payload record, or `undefined` for non-objects.
 */
function unwrapData(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object') return undefined
  const data = (body as { data?: unknown }).data
  return (data && typeof data === 'object' ? data : body) as Record<string, unknown>
}

/**
 * Coerces numeric or numeric-string console fields.
 * @param value Raw field value.
 * @returns Finite number, or `undefined` for blanks and non-numbers.
 */
function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

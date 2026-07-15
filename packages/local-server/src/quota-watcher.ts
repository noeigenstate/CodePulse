import { open } from 'node:fs/promises'
import {
  type AgentEvent,
  type TokenPayload,
  parseTokenCount,
  workspaceKey,
} from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'

/** Large multi-agent rollouts bury token_count under tool noise — keep a deep tail. */
const TAIL_BYTES = 4 * 1024 * 1024
const DEFAULT_CODEX_CONTEXT_WINDOW = 256_000
const DEFAULT_SCHEDULE_OFFSETS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const
/** After a reset (or soft-reset), keep re-reading the bound file for fresh CLI writes. */
const POST_RESET_RETRY_MS = [2_000, 8_000, 20_000, 45_000, 90_000, 180_000] as const
/** Steady re-read of remembered rollout paths while CLI may still write after idle. */
const STEADY_POLL_MS = 12_000
const MAX_TIMEOUT_MS = 2_147_483_647
type QuotaWindowKey = 'fiveHour' | 'sevenDay'

interface BoundQuotaSource {
  sourcePath: string
  source: 'codex'
  externalSessionId?: string
  externalTurnId?: string
  workspacePath?: string
  cwd?: string
}

export interface QuotaRefreshWatcherOptions {
  hub: StatusHub
  now?: () => number
  scheduleOffsetsMs?: readonly number[]
  readToken?: (sourcePath: string) => Promise<TokenPayload | undefined>
  /** Disable steady poll (tests). */
  disableSteadyPoll?: boolean
}

export class QuotaRefreshWatcher {
  private readonly hub: StatusHub
  private readonly now: () => number
  private readonly scheduleOffsetsMs: readonly number[]
  private readonly readToken: (sourcePath: string) => Promise<TokenPayload | undefined>
  private readonly disableSteadyPoll: boolean
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly bindings = new Map<string, BoundQuotaSource>()
  private steady?: NodeJS.Timeout

  constructor(options: QuotaRefreshWatcherOptions) {
    this.hub = options.hub
    this.now = options.now ?? Date.now
    this.scheduleOffsetsMs = options.scheduleOffsetsMs ?? DEFAULT_SCHEDULE_OFFSETS_MS
    this.readToken = options.readToken ?? readCodexQuotaTokenFromFile
    this.disableSteadyPoll = options.disableSteadyPoll ?? false
  }

  observe(event: AgentEvent): void {
    if (event.source !== 'codex' || !event.tokenSourcePath) return
    // Remember path even when rateLimits were soft-stripped — still need post-reset poll.
    if (!event.token) return

    const binding: BoundQuotaSource = {
      source: 'codex',
      sourcePath: event.tokenSourcePath,
      externalSessionId: event.externalSessionId,
      externalTurnId: event.externalTurnId,
      workspacePath: event.workspacePath,
      cwd: event.cwd,
    }
    this.remember(binding)

    if (event.token.rateLimits) {
      for (const reset of resetWindows(event.token)) {
        this.schedule(binding, reset.window, reset.resetAt)
      }
      // If any window already past reset, immediately arm post-reset retries.
      for (const reset of resetWindows(event.token)) {
        const resetMs = normalizeResetAt(reset.resetAt)
        if (resetMs <= this.now()) {
          this.schedulePostResetRetries(binding, reset.window, reset.resetAt)
        }
      }
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.steady) clearInterval(this.steady)
    this.steady = undefined
    this.bindings.clear()
  }

  private remember(binding: BoundQuotaSource): void {
    this.bindings.set(binding.sourcePath, binding)
    this.ensureSteadyPoll()
  }

  private ensureSteadyPoll(): void {
    if (this.disableSteadyPoll || this.steady) return
    this.steady = setInterval(() => {
      void this.pollAll()
    }, STEADY_POLL_MS)
    this.steady.unref?.()
  }

  private async pollAll(): Promise<void> {
    for (const binding of this.bindings.values()) {
      await this.refresh(binding, 'sevenDay', this.now(), { force: true })
    }
  }

  private schedule(binding: BoundQuotaSource, window: QuotaWindowKey, resetAt: number): void {
    for (const offset of this.scheduleOffsetsMs) {
      const runAt = normalizeResetAt(resetAt) + offset
      const delay = runAt - this.now()
      if (delay < 0 || delay > MAX_TIMEOUT_MS) continue

      if (delay === 0) {
        void this.refresh(binding, window, runAt)
        continue
      }

      const key = `${binding.source}\0${binding.sourcePath}\0${window}\0${resetAt}\0${offset}`
      if (this.timers.has(key)) continue

      const timer = setTimeout(() => {
        this.timers.delete(key)
        void this.refresh(binding, window, runAt).then(() => {
          this.schedulePostResetRetries(binding, window, resetAt)
        })
      }, delay)
      timer.unref?.()
      this.timers.set(key, timer)
    }
  }

  private schedulePostResetRetries(
    binding: BoundQuotaSource,
    window: QuotaWindowKey,
    resetAt: number,
  ): void {
    for (const offset of POST_RESET_RETRY_MS) {
      const key = `retry\0${binding.sourcePath}\0${window}\0${resetAt}\0${offset}`
      if (this.timers.has(key)) continue
      const timer = setTimeout(() => {
        this.timers.delete(key)
        void this.refresh(binding, window, normalizeResetAt(resetAt), { force: true })
      }, offset)
      timer.unref?.()
      this.timers.set(key, timer)
    }
  }

  private async refresh(
    binding: BoundQuotaSource,
    window: QuotaWindowKey,
    scheduledResetAt: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const token = await this.readToken(binding.sourcePath)
    if (!token) return

    // Non-force path: skip re-applying the same pre-reset snapshot (tests + avoid churn).
    if (
      !options.force &&
      token.rateLimits &&
      hasUnchangedPreResetSnapshot(token, window, scheduledResetAt)
    ) {
      return
    }

    // Never re-publish a strictly worse same-window snapshot from a stale rollout.
    // Hub merge is also monotonic, but skipping avoids lastEventAt thrash across agents.
    if (isDominatedByCurrentHubQuota(this.hub, binding, token)) {
      return
    }

    this.hub.ingest({
      id: `quota-refresh:${binding.source}:${workspaceKey(binding.workspacePath ?? binding.cwd)}:${this.now()}`,
      source: binding.source,
      eventType: 'token_snapshot',
      externalSessionId: binding.externalSessionId,
      externalTurnId: binding.externalTurnId,
      workspacePath: binding.workspacePath,
      cwd: binding.cwd,
      token,
      tokenSourcePath: binding.sourcePath,
      internal: { quotaRefresh: true },
      timestamp: this.now(),
    })
  }
}

/**
 * True when every window on `incoming` is the same resetsAt as some live codex
 * agent but at a strictly lower used% — classic stale-rollout noise.
 */
function isDominatedByCurrentHubQuota(
  hub: StatusHub,
  binding: BoundQuotaSource,
  incoming: TokenPayload,
): boolean {
  const next = incoming.rateLimits
  if (!next) return false

  const agents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
  if (agents.length === 0) return false

  // Prefer matching the same workspace/session when present.
  const scoped =
    agents.find(
      (agent) =>
        binding.externalSessionId &&
        agent.externalSessionId &&
        agent.externalSessionId === binding.externalSessionId,
    ) ??
    agents.find((agent) => {
      const key = workspaceKey(binding.workspacePath ?? binding.cwd)
      return key && workspaceKey(agent.workspacePath) === key
    })

  const pool = scoped ? [scoped, ...agents] : agents
  for (const agent of pool) {
    const cur = agent.token?.rateLimits
    if (!cur) continue
    if (rateLimitsDominate(cur, next)) return true
  }
  return false
}

/** True when `current` is at least as high as `incoming` on every shared *active* window. */
function rateLimitsDominate(
  current: NonNullable<TokenPayload['rateLimits']>,
  incoming: NonNullable<TokenPayload['rateLimits']>,
  nowMs = Date.now(),
): boolean {
  let compared = false
  for (const key of ['fiveHour', 'sevenDay'] as const) {
    const c = current[key]
    const n = incoming[key]
    if (n?.usedPercent === undefined) continue
    if (!c) return false
    if (!sameResetAtValue(c.resetsAt, n.resetsAt)) return false
    // Expired windows may soft-reset to 0% — never treat that as "dominated".
    const resetRaw = n.resetsAt ?? c.resetsAt
    if (typeof resetRaw === 'number' && Number.isFinite(resetRaw)) {
      if (normalizeResetAt(resetRaw) <= nowMs) return false
    }
    compared = true
    if ((c.usedPercent ?? 0) < (n.usedPercent ?? 0)) return false
  }
  return compared
}

function sameResetAtValue(a: number | undefined, b: number | undefined): boolean {
  if (a == null || b == null) return false
  const am = a < 1_000_000_000_000 ? a * 1000 : a
  const bm = b < 1_000_000_000_000 ? b * 1000 : b
  return am === bm
}

export async function readCodexQuotaTokenFromFile(
  sourcePath: string,
): Promise<TokenPayload | undefined> {
  const lines = (await readTail(sourcePath)).trim().split(/\r?\n/)
  let tokenCount: Record<string, unknown> | undefined
  let tokenCountWithLimits: Record<string, unknown> | undefined
  let taskStarted: Record<string, unknown> | undefined
  const nowMs = Date.now()

  for (let i = lines.length - 1; i >= 0; i--) {
    let item: unknown
    try {
      item = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    if (!isRecord(item) || item.type !== 'event_msg') continue
    const payload = isRecord(item.payload) ? item.payload : undefined
    if (payload?.type === 'token_count') {
      if (!tokenCount) tokenCount = payload
      if (
        !tokenCountWithLimits &&
        tokenCountPayloadHasRateLimits(payload) &&
        payloadRateLimitsAreActive(payload, nowMs)
      ) {
        tokenCountWithLimits = payload
      }
    }
    if (!taskStarted && payload?.type === 'task_started') taskStarted = payload
    if (tokenCount && tokenCountWithLimits && taskStarted) break
  }

  if (!tokenCount) return undefined
  const token = toCodexToken(tokenCount, taskStarted)
  if (!token) return undefined
  if (!token.rateLimits && tokenCountWithLimits && tokenCountWithLimits !== tokenCount) {
    const withLimits = toCodexToken(tokenCountWithLimits, taskStarted)
    if (withLimits?.rateLimits && tokenRateLimitsAreActive(withLimits.rateLimits, nowMs)) {
      token.rateLimits = withLimits.rateLimits
      token.rateLimitId = withLimits.rateLimitId
      token.rateLimitName = withLimits.rateLimitName
    }
  } else if (token.rateLimits && !tokenRateLimitsAreActive(token.rateLimits, nowMs)) {
    // Soft-reset: CLI has not written post-reset token_count yet.
    // Show 0% + past resetsAt ("可刷新") instead of wiping limits → "等待命令行同步额度".
    token.rateLimits = softResetExpiredRateLimits(token.rateLimits, nowMs)
  }
  return token
}

type RateWindow = NonNullable<NonNullable<TokenPayload['rateLimits']>['fiveHour']>

function softResetExpiredRateLimits(
  rateLimits: NonNullable<TokenPayload['rateLimits']>,
  nowMs: number,
): NonNullable<TokenPayload['rateLimits']> {
  return {
    fiveHour: softResetWindow(rateLimits.fiveHour, nowMs),
    sevenDay: softResetWindow(rateLimits.sevenDay, nowMs),
  }
}

function softResetWindow(window: RateWindow | undefined, nowMs: number): RateWindow | undefined {
  if (!window) return undefined
  const resetsAt = window.resetsAt
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) {
    return { ...window, usedPercent: 0 }
  }
  const resetMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
  if (resetMs > nowMs) return window
  return { ...window, usedPercent: 0 }
}

function payloadRateLimitsAreActive(payload: Record<string, unknown>, nowMs: number): boolean {
  const token = toCodexToken(payload, undefined)
  return tokenRateLimitsAreActive(token?.rateLimits, nowMs)
}

function tokenRateLimitsAreActive(
  rateLimits: TokenPayload['rateLimits'] | undefined,
  nowMs: number,
): boolean {
  if (!rateLimits) return false
  const windows = [rateLimits.fiveHour, rateLimits.sevenDay].filter(Boolean)
  if (windows.length === 0) return false

  let sawReset = false
  for (const window of windows) {
    const resetsAt = window?.resetsAt
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) continue
    sawReset = true
    const resetMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
    if (resetMs > nowMs) return true
  }
  if (!sawReset) return true
  return false
}

function tokenCountPayloadHasRateLimits(payload: Record<string, unknown>): boolean {
  const info = isRecord(payload.info) ? payload.info : undefined
  const raw = payload.rate_limits ?? info?.rate_limits
  if (!isRecord(raw)) return false
  return Boolean(
    raw.primary || raw.secondary || raw.five_hour || raw.fiveHour || raw.seven_day || raw.sevenDay,
  )
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function toCodexToken(
  tokenCount: Record<string, unknown>,
  taskStarted: Record<string, unknown> | undefined,
): TokenPayload | undefined {
  const info = isRecord(tokenCount.info) ? tokenCount.info : {}
  const usage = readUsage(info.total_token_usage) ?? readUsage(info.last_token_usage)
  // Context bar: last model-call only — never total_token_usage (cumulative).
  const contextUsage = readUsage(info.last_token_usage)
  const rawRateLimits = tokenCount.rate_limits ?? info.rate_limits
  const rateLimits = normalizeRateLimits(rawRateLimits)
  const rateLimitId = readRateLimitString(rawRateLimits, 'limit_id', 'limitId')
  const rateLimitName = readRateLimitString(rawRateLimits, 'limit_name', 'limitName')
  const contextWindow =
    optionalNumber(info.model_context_window) ??
    optionalNumber(taskStarted?.model_context_window) ??
    DEFAULT_CODEX_CONTEXT_WINDOW
  const contextInput =
    optionalNumber(contextUsage?.input_tokens) ?? optionalNumber(contextUsage?.cached_input_tokens)
  const contextUsedPercent =
    contextUsage && contextWindow && contextInput
      ? Math.min(100, (contextInput / contextWindow) * 100)
      : undefined

  if (!usage && !contextUsage && !rateLimits && contextUsedPercent === undefined) return undefined

  return {
    input: optionalNumber(usage?.input_tokens),
    cachedInput: optionalNumber(usage?.cached_input_tokens),
    output: optionalNumber(usage?.output_tokens),
    reasoningOutput: optionalNumber(usage?.reasoning_output_tokens),
    total: optionalNumber(usage?.total_tokens),
    contextUsedPercent,
    contextWindow,
    rateLimits,
    rateLimitId,
    rateLimitName,
    accuracy: 'estimated',
  }
}

function readUsage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function normalizeRateLimits(value: unknown): TokenPayload['rateLimits'] {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined

  const explicitFive = normalizeWindow(raw.five_hour ?? raw.fiveHour)
  const explicitSeven = normalizeWindow(raw.seven_day ?? raw.sevenDay)
  if (explicitFive || explicitSeven) {
    return { fiveHour: explicitFive, sevenDay: explicitSeven }
  }

  const primary = normalizeWindow(raw.primary)
  const secondary = normalizeWindow(raw.secondary)
  if (!primary && !secondary) return undefined

  return classifyPrimarySecondaryWindows(primary, secondary)
}

type RateLimitWindow = NonNullable<TokenPayload['rateLimits']>['fiveHour']

function classifyPrimarySecondaryWindows(
  primary: RateLimitWindow,
  secondary: RateLimitWindow,
): NonNullable<TokenPayload['rateLimits']> {
  const fiveHour: NonNullable<RateLimitWindow>[] = []
  const sevenDay: NonNullable<RateLimitWindow>[] = []

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

function classifyWindowKind(
  window: NonNullable<RateLimitWindow>,
): 'fiveHour' | 'sevenDay' | 'unknown' {
  const minutes = window.windowMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'unknown'
  if (minutes <= 24 * 60) return 'fiveHour'
  return 'sevenDay'
}

function normalizeWindow(value: unknown): NonNullable<TokenPayload['rateLimits']>['fiveHour'] {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  const usedPercent = optionalNumber(raw.used_percentage ?? raw.usedPercent ?? raw.used_percent)
  const resetsAt = optionalNumber(raw.resets_at ?? raw.resetsAt)
  const windowMinutes = optionalNumber(raw.window_minutes ?? raw.windowMinutes)
  if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
    return undefined
  }
  return { usedPercent, resetsAt, windowMinutes }
}

function readRateLimitString(value: unknown, ...keys: string[]): string | undefined {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  for (const key of keys) {
    const item = raw[key]
    if (typeof item === 'string' && item.length > 0) return item
  }
  return undefined
}

function resetWindows(token: TokenPayload): Array<{ window: QuotaWindowKey; resetAt: number }> {
  return [
    { window: 'fiveHour' as const, resetAt: token.rateLimits?.fiveHour?.resetsAt },
    { window: 'sevenDay' as const, resetAt: token.rateLimits?.sevenDay?.resetsAt },
  ].filter(
    (item): item is { window: QuotaWindowKey; resetAt: number } =>
      item.resetAt !== undefined && Number.isFinite(item.resetAt),
  )
}

/**
 * True when the file still only has the pre-reset high-usage snapshot for this window
 * (same resets_at, not a new post-reset period).
 */
function hasUnchangedPreResetSnapshot(
  token: TokenPayload,
  window: QuotaWindowKey,
  scheduledResetAt: number,
): boolean {
  const resetAt = token.rateLimits?.[window]?.resetsAt
  if (resetAt === undefined) return false
  const normalized = normalizeResetAt(resetAt)
  // Still the same period marker that just fired → not a fresh post-reset write.
  return normalized <= scheduledResetAt && (token.rateLimits?.[window]?.usedPercent ?? 0) > 0
}

function normalizeResetAt(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function optionalNumber(value: unknown): number | undefined {
  return parseTokenCount(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

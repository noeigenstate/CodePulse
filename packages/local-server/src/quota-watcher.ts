import { open } from 'node:fs/promises'
import {
  type AgentEvent,
  type TokenPayload,
  type TurnTiming,
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

/**
 * Fresh Codex data read from one rollout tail.
 *
 * `model`, `reasoningEffort`, and `modelObservedAt` originate from one native
 * configuration envelope and therefore must be consumed as an atomic snapshot.
 */
export interface CodexRolloutSnapshot {
  token?: TokenPayload
  model?: string
  reasoningEffort?: string
  modelObservedAt?: number
  /** Latest native Codex task lifecycle timing recovered from the rollout tail. */
  turnTiming?: TurnTiming
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

/**
 * Reads the latest quota token and model configuration from one Codex rollout.
 *
 * One tail read keeps session sync from parsing the same multi-megabyte JSONL
 * file twice. The newest valid configuration envelope wins, even when old
 * `turn_context` entries remain near the file head.
 *
 * @param sourcePath Absolute rollout JSONL path.
 * @returns Latest independently available token and model configuration fields.
 */
export async function readCodexRolloutSnapshotFromFile(
  sourcePath: string,
): Promise<CodexRolloutSnapshot> {
  const lines = (await readTail(sourcePath)).trim().split(/\r?\n/)
  let tokenCount: Record<string, unknown> | undefined
  let tokenCountWithLimits: Record<string, unknown> | undefined
  let taskStarted: Record<string, unknown> | undefined
  let modelConfig: CodexModelConfig | undefined
  const terminalTasks = new Map<string, CodexTaskTerminal>()
  const activeTasks: CodexTaskStart[] = []
  let latestCompletedTask: CodexTaskTerminal | undefined
  const nowMs = Date.now()

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? ''
    // A rollout tail can contain thousands of reasoning and tool-output rows.
    // Scan all lines for lifecycle matching, but parse JSON only for envelopes
    // that can carry token, model, or task timing data.
    if (!isCodexTimingOrUsageEnvelope(line)) continue
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(item)) continue
    if (!modelConfig) modelConfig = readCodexModelConfig(item)
    if (item.type !== 'event_msg') continue
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

    const taskType = readString(payload, 'type')
    if (payload && (taskType === 'task_complete' || taskType === 'turn_aborted')) {
      const terminal = readCodexTaskTerminal(payload, item)
      if (terminal) {
        if (!latestCompletedTask || terminal.observedAt >= latestCompletedTask.observedAt) {
          latestCompletedTask = terminal
        }
        if (terminal.turnId) terminalTasks.set(terminal.turnId, terminal)
      }
    } else if (payload && taskType === 'task_started') {
      const start = readCodexTaskStart(payload, item)
      const terminal = start?.turnId ? terminalTasks.get(start.turnId) : undefined
      if (terminal && start) terminal.startedAt = start.startedAt
      else if (start) activeTasks.push(start)
    }
  }

  const token = tokenCount
    ? finalizeCodexToken(tokenCount, tokenCountWithLimits, taskStarted, nowMs)
    : undefined
  const turnTiming = selectCodexTurnTiming(activeTasks, latestCompletedTask)
  return { ...(token ? { token } : {}), ...modelConfig, ...(turnTiming ? { turnTiming } : {}) }
}

/**
 * Fast-filters rollout JSONL rows before JSON parsing during periodic scans.
 *
 * @param line Raw JSONL row.
 * @returns `true` when the row can contain a token, model, or task-timing envelope.
 */
function isCodexTimingOrUsageEnvelope(line: string): boolean {
  return (
    line.includes('"token_count"') ||
    line.includes('"turn_context"') ||
    line.includes('"thread_settings_applied"') ||
    line.includes('"task_started"') ||
    line.includes('"task_complete"') ||
    line.includes('"turn_aborted"')
  )
}

/**
 * Reads only the quota token required by scheduled quota refreshes.
 *
 * @param sourcePath Absolute rollout JSONL path.
 * @returns Latest quota token, when the rollout contains one.
 */
export async function readCodexQuotaTokenFromFile(
  sourcePath: string,
): Promise<TokenPayload | undefined> {
  return (await readCodexRolloutSnapshotFromFile(sourcePath)).token
}

/**
 * Applies rate-limit backfill and soft-reset rules to the newest token count.
 *
 * @param tokenCount Latest `token_count` payload.
 * @param tokenCountWithLimits Newest active quota-bearing `token_count` payload.
 * @param taskStarted Optional task metadata used for context-window fallback.
 * @param nowMs Current epoch milliseconds for reset validation.
 * @returns Normalized token payload, if usable usage data exists.
 */
function finalizeCodexToken(
  tokenCount: Record<string, unknown>,
  tokenCountWithLimits: Record<string, unknown> | undefined,
  taskStarted: Record<string, unknown> | undefined,
  nowMs: number,
): TokenPayload | undefined {
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

/** Native Codex model configuration retained with its rollout timestamp. */
interface CodexModelConfig {
  model: string
  reasoningEffort?: string
  modelObservedAt?: number
}

/** A native Codex `task_started` record normalized for lifecycle matching. */
interface CodexTaskStart {
  turnId?: string
  startedAt: number
}

/** A native Codex terminal task record normalized for lifecycle matching. */
interface CodexTaskTerminal {
  turnId?: string
  startedAt?: number
  elapsedMs: number
  observedAt: number
}

/**
 * Parses a native Codex task-start record without treating the JSONL file mtime
 * as task time.
 *
 * @param payload Parsed `event_msg` payload.
 * @param envelope Parsed JSONL envelope.
 * @returns A valid task start record, or `undefined` when timestamps are absent.
 */
function readCodexTaskStart(
  payload: Record<string, unknown>,
  envelope: Record<string, unknown>,
): CodexTaskStart | undefined {
  const startedAt =
    parseRolloutTimestamp(payload.started_at) ?? parseRolloutTimestamp(envelope.timestamp)
  if (startedAt == null || startedAt <= 0) return undefined
  return { turnId: readString(payload, 'turn_id', 'turnId'), startedAt }
}

/**
 * Parses a native Codex completed or aborted task record.
 *
 * @param payload Parsed `event_msg` payload.
 * @param envelope Parsed JSONL envelope.
 * @returns A terminal duration record, or `undefined` when native timing is unusable.
 */
function readCodexTaskTerminal(
  payload: Record<string, unknown>,
  envelope: Record<string, unknown>,
): CodexTaskTerminal | undefined {
  const observedAt =
    parseRolloutTimestamp(payload.completed_at) ?? parseRolloutTimestamp(envelope.timestamp)
  const elapsedMs = optionalNumber(payload.duration_ms) ?? optionalNumber(payload.durationMs)
  if (observedAt == null || observedAt <= 0 || elapsedMs == null || elapsedMs < 0) return undefined
  return {
    turnId: readString(payload, 'turn_id', 'turnId'),
    elapsedMs,
    observedAt,
  }
}

/**
 * Picks one card-level timing value from a rollout that may include several
 * agent turns. Only starts newer than the newest terminal can still describe an
 * active foreground turn; this prevents a historical interrupted start from
 * reviving a completed card after a restart. Codex does not expose a stable
 * foreground-turn marker when several tasks remain unclosed, so the newest
 * start is the conservative best-effort proxy for the card's current turn.
 *
 * @param activeTasks Unmatched native task starts from the rollout tail.
 * @param latestCompletedTask Newest native task completion from the rollout tail.
 * @returns The timing snapshot suitable for the project card, when available.
 */
function selectCodexTurnTiming(
  activeTasks: readonly CodexTaskStart[],
  latestCompletedTask: CodexTaskTerminal | undefined,
): TurnTiming | undefined {
  const currentTasks = activeTasks.filter(
    (candidate) =>
      latestCompletedTask == null || candidate.startedAt >= latestCompletedTask.observedAt,
  )
  const active = currentTasks.reduce<CodexTaskStart | undefined>(
    (latest, candidate) => (!latest || candidate.startedAt > latest.startedAt ? candidate : latest),
    undefined,
  )
  if (active) {
    return {
      state: 'active',
      startedAt: active.startedAt,
      observedAt: active.startedAt,
    }
  }
  if (!latestCompletedTask) return undefined
  return {
    state: 'completed',
    ...(latestCompletedTask.startedAt !== undefined
      ? { startedAt: latestCompletedTask.startedAt }
      : {}),
    elapsedMs: latestCompletedTask.elapsedMs,
    observedAt: latestCompletedTask.observedAt,
  }
}

/**
 * Extracts the model configuration from a single Codex JSONL envelope.
 *
 * `turn_context` and `thread_settings_applied` use different field layouts, so
 * both are supported. Each candidate is read as a unit to keep model and effort
 * from the same turn.
 *
 * @param envelope Parsed rollout JSONL envelope.
 * @returns Timestamped configuration when this envelope provides one.
 */
function readCodexModelConfig(envelope: Record<string, unknown>): CodexModelConfig | undefined {
  const payload = isRecord(envelope.payload) ? envelope.payload : undefined
  if (!payload) return undefined

  const collaboration = isRecord(payload.collaboration_mode)
    ? payload.collaboration_mode
    : undefined
  const candidates =
    envelope.type === 'turn_context'
      ? [payload, isRecord(collaboration?.settings) ? collaboration.settings : undefined]
      : [
          isRecord(payload.thread_settings) ? payload.thread_settings : undefined,
          isRecord(collaboration?.settings) ? collaboration.settings : undefined,
        ]

  for (const settings of candidates) {
    const model = readString(settings, 'model')
    if (!model) continue
    const reasoningEffort = readString(settings, 'reasoning_effort', 'reasoningEffort', 'effort')
    const modelObservedAt = parseRolloutTimestamp(envelope.timestamp)
    return {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(modelObservedAt !== undefined ? { modelObservedAt } : {}),
    }
  }
  return undefined
}

/**
 * Parses a rollout envelope timestamp into epoch milliseconds.
 *
 * @param value ISO timestamp or numeric epoch from a JSONL envelope.
 * @returns Finite epoch milliseconds when the value is usable.
 */
function parseRolloutTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed)) return parsed
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return undefined
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
}

/**
 * Finds the first non-empty string among a record's candidate keys.
 *
 * @param record Parsed JSON record to inspect.
 * @param keys Candidate field names in priority order.
 * @returns Trimmed string value when available.
 */
function readString(
  record: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!record) return undefined
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
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

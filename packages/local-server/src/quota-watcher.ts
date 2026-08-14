import { open } from 'node:fs/promises'
import {
  type AgentEvent,
  type TokenPayload,
  type TurnTiming,
  parseTokenCount,
  workspaceKey,
} from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import { resolveCodexModelContextWindow } from './codex-model-cache.js'

/** Small reverse reads keep routine polling cheap while still crossing noisy tool output. */
const ROLLOUT_SCAN_CHUNK_BYTES = 1024 * 1024
/** Never rescan an entire multi-hundred-megabyte rollout during a periodic refresh. */
const MAX_ROLLOUT_SCAN_BYTES = 32 * 1024 * 1024
const DEFAULT_SCHEDULE_OFFSETS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const
/** After a reset boundary, keep re-reading the bound file for fresh CLI writes. */
const POST_RESET_RETRY_MS = [2_000, 8_000, 20_000, 45_000, 90_000, 180_000] as const
/** Steady re-read of remembered rollout paths while CLI may still write after idle. */
const STEADY_POLL_MS = 12_000
/** Keep only a small working set of fallback paths; Codex quota is account-wide. */
const MAX_REMEMBERED_BINDINGS = 8
/** Poll at most one likely main and one likely Spark rollout on each steady tick. */
const MAX_STEADY_POLL_BINDINGS = 2
/** Retire paths that have not appeared in a live event for half an hour. */
const BINDING_IDLE_TTL_MS = 30 * 60_000
const MAX_TIMEOUT_MS = 2_147_483_647
type QuotaWindowKey = 'fiveHour' | 'sevenDay'

interface BoundQuotaSource {
  sourcePath: string
  source: 'codex'
  externalSessionId?: string
  externalTurnId?: string
  workspacePath?: string
  cwd?: string
  lastObservedAt: number
}

/** Result of one physical rollout read shared by concurrent refresh consumers. */
interface QuotaReadObservation {
  token?: TokenPayload
  usageSampleId: string
}

/** Account-quota fields plus the identity of the native row that produced them. */
export interface CodexQuotaObservation {
  token?: TokenPayload
  /** Stable within one append-only rollout, even when unrelated rows are appended later. */
  observationIdentity?: string
}

/**
 * Fresh Codex data read from one rollout tail.
 *
 * `model`, `reasoningEffort`, and `modelObservedAt` originate from one native
 * configuration envelope and therefore must be consumed as an atomic snapshot.

 */
export interface CodexRolloutSnapshot {
  token?: TokenPayload
  /** Timestamp of the native quota-bearing `token_count` envelope. */
  quotaObservedAt?: number
  /** Byte-stable identity of the native quota-bearing JSONL row. */
  quotaObservationIdentity?: string
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
  /** Native observation reader; production uses this to deduplicate cached JSONL rows. */
  readObservation?: (sourcePath: string) => Promise<CodexQuotaObservation>
  /** Whether Codex App Server has become the authoritative account quota source. */
  isCodexQuotaAuthoritative?: () => boolean
  /** Disable steady poll (tests). */
  disableSteadyPoll?: boolean
}

/**
 * Watches Codex rollout files and republishes fresh account-quota snapshots.
 *
 * The watcher schedules reads around reset boundaries and performs a bounded
 * steady poll until an authoritative App Server quota source takes over.

 */
export class QuotaRefreshWatcher {
  private readonly hub: StatusHub
  private readonly now: () => number
  private readonly scheduleOffsetsMs: readonly number[]
  private readonly readObservation: (sourcePath: string) => Promise<CodexQuotaObservation>
  private readonly isCodexQuotaAuthoritative: () => boolean
  private readonly disableSteadyPoll: boolean
  private readonly timers = new Map<string, NodeJS.Timeout>()
  private readonly bindings = new Map<string, BoundQuotaSource>()
  private readonly reads = new Map<string, Promise<QuotaReadObservation>>()
  private steady?: NodeJS.Timeout
  private pollPromise?: Promise<void>
  private generation = 0
  private stopped = false
  /** Monotonic discriminator so rapid reads in one millisecond remain distinct samples. */
  private sampleSequence = 0

  /**
   * Creates a quota refresh watcher without starting timers.
   *
   * @param options Hub, clock, reader, and scheduling overrides for the watcher.

   */
  constructor(options: QuotaRefreshWatcherOptions) {
    this.hub = options.hub
    this.now = options.now ?? Date.now
    this.scheduleOffsetsMs = options.scheduleOffsetsMs ?? DEFAULT_SCHEDULE_OFFSETS_MS
    this.readObservation = options.readObservation
      ? options.readObservation
      : options.readToken
        ? async (sourcePath) => ({ token: await options.readToken!(sourcePath) })
        : readCodexQuotaObservationFromFile
    this.isCodexQuotaAuthoritative = options.isCodexQuotaAuthoritative ?? (() => false)
    this.disableSteadyPoll = options.disableSteadyPoll ?? false
  }

  /**
   * Records a live Codex event and schedules reads around its quota resets.
   *
   * @param event Normalized agent event that may identify a Codex rollout file.

   */
  observe(event: AgentEvent): void {
    if (this.stopped) return
    if (event.source !== 'codex' || !event.tokenSourcePath) return
    if (this.isCodexQuotaAuthoritative()) return
    // Refresh events are outputs of this watcher (or account-only sync). Feeding
    // them back into scheduling would re-arm the same reset retry indefinitely.
    if (event.internal?.quotaRefresh) return
    // Remember the path even when this event omits limits; post-reset polling still needs it.
    if (!event.token) return

    const binding: BoundQuotaSource = {
      source: 'codex',
      sourcePath: event.tokenSourcePath,
      externalSessionId: event.externalSessionId,
      externalTurnId: event.externalTurnId,
      workspacePath: event.workspacePath,
      cwd: event.cwd,
      lastObservedAt: this.now(),
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

  /** Stops the watcher permanently and clears all pending fallback work. */
  stop(): void {
    this.stopped = true
    this.reset()
  }

  /**
   * Clears remembered rollout bindings and every scheduled fallback read.
   *
   * The local server calls this when Codex App Server establishes an official
   * account quota stream or detects an account switch. Existing JSONL bindings
   * must not publish an older account's higher percentage afterward.

   */
  reset(): void {
    this.generation += 1
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    if (this.steady) clearInterval(this.steady)
    this.steady = undefined
    this.bindings.clear()
  }

  /**
   * Retains one recently observed rollout binding for fallback polling.
   *
   * @param binding Codex rollout source and the event identity associated with it.

   */
  private remember(binding: BoundQuotaSource): void {
    if (this.stopped) return
    this.bindings.delete(binding.sourcePath)
    this.bindings.set(binding.sourcePath, binding)
    while (this.bindings.size > MAX_REMEMBERED_BINDINGS) {
      const oldestPath = this.bindings.keys().next().value
      if (typeof oldestPath !== 'string') break
      this.forget(oldestPath)
    }
    this.ensureSteadyPoll()
  }

  /**
   * Removes one fallback source and its reset timers.
   *
   * @param sourcePath Absolute rollout path to retire.

   */
  private forget(sourcePath: string): void {
    this.bindings.delete(sourcePath)
    for (const [key, timer] of this.timers) {
      if (!key.includes(`\0${sourcePath}\0`)) continue
      clearTimeout(timer)
      this.timers.delete(key)
    }
  }

  /** Starts the steady polling interval when fallback polling is enabled. */
  private ensureSteadyPoll(): void {
    if (this.stopped || this.disableSteadyPoll || this.steady) return
    this.steady = setInterval(() => {
      void this.pollAll()
    }, STEADY_POLL_MS)
    this.steady.unref?.()
  }

  /**
   * Coalesces overlapping steady polling ticks.
   *
   * @returns The active or newly started polling pass.

   */
  private pollAll(): Promise<void> {
    if (this.pollPromise) return this.pollPromise
    const poll = this.performPollAll().finally(() => {
      if (this.pollPromise === poll) this.pollPromise = undefined
    })
    this.pollPromise = poll
    return poll
  }

  /**
   * Performs one serialized, bounded fallback polling pass.
   *
   * @returns A promise that settles after the selected paths are refreshed.

   */
  private async performPollAll(): Promise<void> {
    if (this.isCodexQuotaAuthoritative()) {
      this.reset()
      return
    }
    const now = this.now()
    for (const binding of [...this.bindings.values()]) {
      if (now - binding.lastObservedAt > BINDING_IDLE_TTL_MS) this.forget(binding.sourcePath)
    }
    const bindings = [...this.bindings.values()]
      .sort((left, right) => right.lastObservedAt - left.lastObservedAt)
      .slice(0, MAX_STEADY_POLL_BINDINGS)
    for (const binding of bindings) {
      await this.refresh(binding, 'sevenDay', this.now(), { force: true })
    }
  }

  /**
   * Schedules the configured refresh offsets for one quota reset boundary.
   *
   * @param binding Rollout source to read when each timer fires.
   * @param window Quota window whose reset is being observed.
   * @param resetAt Quota reset timestamp in seconds or milliseconds since epoch.

   */
  private schedule(binding: BoundQuotaSource, window: QuotaWindowKey, resetAt: number): void {
    if (this.stopped || this.isCodexQuotaAuthoritative()) return
    const generation = this.generation
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
          if (this.stopped || generation !== this.generation || this.isCodexQuotaAuthoritative()) {
            return
          }
          this.schedulePostResetRetries(binding, window, resetAt)
        })
      }, delay)
      timer.unref?.()
      this.timers.set(key, timer)
    }
  }

  /**
   * Schedules bounded retries for delayed rollout writes after a quota reset.
   *
   * @param binding Rollout source to reread after the reset.
   * @param window Quota window whose post-reset value is expected.
   * @param resetAt Quota reset timestamp in seconds or milliseconds since epoch.

   */
  private schedulePostResetRetries(
    binding: BoundQuotaSource,
    window: QuotaWindowKey,
    resetAt: number,
  ): void {
    if (this.stopped || this.isCodexQuotaAuthoritative()) return
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

  /**
   * Reads and publishes one refreshed quota observation when it is still valid.
   *
   * @param binding Rollout source and event identity used for publication.
   * @param window Quota window that caused this refresh.
   * @param scheduledResetAt Normalized reset boundary associated with the read.
   * @param options Refresh behavior overrides.
   * @returns A promise that settles after the refresh is skipped or published.

   */
  private async refresh(
    binding: BoundQuotaSource,
    window: QuotaWindowKey,
    scheduledResetAt: number,
    options: { force?: boolean } = {},
  ): Promise<void> {
    if (this.stopped || this.isCodexQuotaAuthoritative()) return
    const generation = this.generation
    const observation = await this.readTokenSafely(binding.sourcePath)
    if (this.stopped || generation !== this.generation || this.isCodexQuotaAuthoritative()) return
    const token = observation.token
    if (!token) return

    // Non-force path: skip re-applying the same pre-reset snapshot (tests + avoid churn).
    if (
      !options.force &&
      token.rateLimits &&
      hasUnchangedPreResetSnapshot(token, window, scheduledResetAt)
    ) {
      return
    }

    const observedAt = this.now()
    const usageSampleId = observation.usageSampleId
    this.hub.ingest({
      id: `${usageSampleId}:${workspaceKey(binding.workspacePath ?? binding.cwd)}`,
      source: binding.source,
      eventType: 'token_snapshot',
      externalSessionId: binding.externalSessionId,
      externalTurnId: binding.externalTurnId,
      workspacePath: binding.workspacePath,
      cwd: binding.cwd,
      token,
      tokenSourcePath: binding.sourcePath,
      internal: { quotaRefresh: true, usageSampleId },
      timestamp: observedAt,
    })
  }

  /**
   * Coalesces concurrent reads of one rollout and contains filesystem errors.
   *
   * @param sourcePath Absolute rollout path to read.
   * @returns Parsed token and one sample ID shared by every coalesced consumer.

   */
  private readTokenSafely(sourcePath: string): Promise<QuotaReadObservation> {
    const existing = this.reads.get(sourcePath)
    if (existing) return existing
    this.sampleSequence += 1
    const usageSampleId = `quota-refresh:codex:${sourcePath}:${this.now()}:${this.sampleSequence}`
    const read = this.readObservation(sourcePath)
      .then((observation) => ({
        token: observation.token,
        usageSampleId: observation.observationIdentity
          ? `codex-rollout:${sourcePath}:${observation.observationIdentity}`
          : usageSampleId,
      }))
      .catch(() => ({ token: undefined, usageSampleId }))
      .finally(() => {
        if (this.reads.get(sourcePath) === read) this.reads.delete(sourcePath)
      })
    this.reads.set(sourcePath, read)
    return read
  }
}

/**
 * Reads the latest quota token and model configuration from one Codex rollout.
 *
 * Rows are read newest-first in non-overlapping blocks. Routine snapshots stop
 * after the first block once every required record is present; older blocks are
 * visited only when tool output separated the latest usage from its model,
 * quota, or lifecycle metadata. The newest valid configuration envelope wins.
 *
 * @param sourcePath Absolute rollout JSONL path.
 * @param options Model-cache location plus quota inclusion and quota-only scan flags.
 * @returns Latest independently available token and model configuration fields.

 */
export async function readCodexRolloutSnapshotFromFile(
  sourcePath: string,
  options: {
    codexHome?: string
    includeQuota?: boolean
    quotaOnly?: boolean
    expectedTerminalTurnId?: string
    onScanBytes?: (totalBytes: number) => void
  } = {},
): Promise<CodexRolloutSnapshot> {
  let tokenCount: Record<string, unknown> | undefined
  let tokenCountWithLimits: Record<string, unknown> | undefined
  let quotaObservedAt: number | undefined
  let quotaObservationIdentity: string | undefined
  let taskStarted: Record<string, unknown> | undefined
  let modelConfig: CodexModelConfig | undefined
  const terminalTasks = new Map<string, CodexTaskTerminal>()
  const activeTasks: CodexTaskStart[] = []
  let latestTerminalTask: CodexTaskTerminal | undefined
  let sawLifecycle = false
  let lifecycleBoundaryReached = false
  let expectedTerminalStartMatched = false
  for await (const row of readRolloutRowsReverse(sourcePath, {
    onBytesRead: options.onScanBytes,
  })) {
    // A rollout tail can contain thousands of reasoning and tool-output rows.
    // Search bytes first so multi-megabyte irrelevant rows are never decoded.
    if (!isCodexTimingOrUsageEnvelope(row.data)) continue
    let item: unknown
    try {
      item = JSON.parse(row.data.toString('utf8'))
    } catch {
      continue
    }
    if (!isRecord(item)) continue
    const reachedSessionStart = item.type === 'session_meta'
    if (reachedSessionStart && sawLifecycle) {
      // Only the session header proves there is no older root task. A
      // turn_context can sit between a parent task and a nested child task.
      lifecycleBoundaryReached = true
    }
    if (!modelConfig) modelConfig = readCodexModelConfig(item)
    if (item.type === 'event_msg') {
      const payload = isRecord(item.payload) ? item.payload : undefined
      if (payload?.type === 'token_count') {
        if (!tokenCount) tokenCount = payload
        if (!tokenCountWithLimits && tokenCountPayloadHasRateLimits(payload)) {
          tokenCountWithLimits = payload
          quotaObservedAt =
            parseRolloutTimestamp(item.timestamp) ?? deterministicQuotaObservationId(payload)
          quotaObservationIdentity = `${row.startOffset}:${quotaObservedAt}`
        }
      }
      if (!taskStarted && payload?.type === 'task_started') taskStarted = payload

      const taskType = readString(payload, 'type')
      if (payload && (taskType === 'task_complete' || taskType === 'turn_aborted')) {
        sawLifecycle = true
        const terminal = readCodexTaskTerminal(payload, item, taskType)
        if (terminal) {
          if (!latestTerminalTask || terminal.observedAt >= latestTerminalTask.observedAt) {
            latestTerminalTask = terminal
          }
          if (terminal.turnId) terminalTasks.set(terminal.turnId, terminal)
        }
      } else if (payload && taskType === 'task_started') {
        sawLifecycle = true
        const start = readCodexTaskStart(payload, item)
        const terminal = start?.turnId ? terminalTasks.get(start.turnId) : undefined
        if (terminal && start) {
          terminal.startedAt = start.startedAt
          if (
            terminal === latestTerminalTask &&
            terminal.turnId === options.expectedTerminalTurnId
          ) {
            expectedTerminalStartMatched = true
          }
        } else if (start) activeTasks.push(start)
      }
    }

    if (reachedSessionStart || hasCompleteRolloutSnapshot()) break
  }

  /**
   * Reports whether no older row can improve the normalized snapshot.
   *
   * @returns `true` after usage, quota, model, and lifecycle state are resolved.

   */
  function hasCompleteRolloutSnapshot(): boolean {
    if (options.quotaOnly) return Boolean(tokenCount && tokenCountWithLimits)
    const lifecycleResolved =
      activeTasks.length > 0 ||
      expectedTerminalStartMatched ||
      (latestTerminalTask !== undefined && lifecycleBoundaryReached)
    const quotaResolved = options.includeQuota === false || tokenCountWithLimits !== undefined
    return Boolean(tokenCount && quotaResolved && modelConfig && taskStarted && lifecycleResolved)
  }

  const cachedContextWindow = tokenCount
    ? await resolveCodexModelContextWindow(modelConfig?.model, {
        codexHome: options.codexHome,
        rolloutPath: sourcePath,
      })
    : undefined
  const token = tokenCount
    ? finalizeCodexToken(tokenCount, tokenCountWithLimits, taskStarted, cachedContextWindow)
    : undefined
  const turnTiming = selectCodexTurnTiming(activeTasks, latestTerminalTask)
  return {
    ...(token ? { token } : {}),
    ...(quotaObservedAt !== undefined ? { quotaObservedAt } : {}),
    ...(quotaObservationIdentity ? { quotaObservationIdentity } : {}),
    ...modelConfig,
    ...(turnTiming ? { turnTiming } : {}),
  }
}

/**
 * Fast-filters rollout JSONL rows before JSON parsing during periodic scans.
 *
 * @param row Raw JSONL row bytes.
 * @returns `true` when the row can contain a token, model, or task-timing envelope.

 */
function isCodexTimingOrUsageEnvelope(row: Buffer): boolean {
  return (
    row.includes('"token_count"') ||
    row.includes('"turn_context"') ||
    row.includes('"thread_settings_applied"') ||
    row.includes('"task_started"') ||
    row.includes('"task_complete"') ||
    row.includes('"turn_aborted"') ||
    row.includes('"session_meta"')
  )
}

/**
 * Reads only the quota token required by scheduled quota refreshes.
 *
 * @param sourcePath Absolute rollout JSONL path.
 * @param options Optional Codex home override used to read model metadata.
 * @returns Latest quota token, when the rollout contains one.

 */
export async function readCodexQuotaTokenFromFile(
  sourcePath: string,
  options: { codexHome?: string } = {},
): Promise<TokenPayload | undefined> {
  return (await readCodexQuotaObservationFromFile(sourcePath, options)).token
}

/**
 * Reads account quota together with the stable identity of its native JSONL row.
 *
 * @param sourcePath Absolute rollout JSONL path.
 * @param options Optional Codex home override used for model metadata.
 * @returns Quota-only token and native observation identity, when available.

 */
export async function readCodexQuotaObservationFromFile(
  sourcePath: string,
  options: { codexHome?: string } = {},
): Promise<CodexQuotaObservation> {
  const snapshot = await readCodexRolloutSnapshotFromFile(sourcePath, {
    ...options,
    includeQuota: true,
    quotaOnly: true,
  })
  const token = snapshot.token
  if (!token?.rateLimits) return {}
  return {
    token: {
      rateLimits: token.rateLimits,
      rateLimitId: token.rateLimitId,
      rateLimitName: token.rateLimitName,
      accuracy: token.accuracy,
    },
    observationIdentity: snapshot.quotaObservationIdentity,
  }
}

/**
 * Backfills the newest official rate-limit snapshot onto the newest token count.
 *
 * @param tokenCount Latest `token_count` payload.
 * @param tokenCountWithLimits Newest quota-bearing `token_count` payload.
 * @param taskStarted Optional task metadata used for context-window fallback.
 * @param cachedContextWindow Exact model-specific window from `models_cache.json`.
 * @returns Normalized token payload, if usable usage data exists.

 */
function finalizeCodexToken(
  tokenCount: Record<string, unknown>,
  tokenCountWithLimits: Record<string, unknown> | undefined,
  taskStarted: Record<string, unknown> | undefined,
  cachedContextWindow: number | undefined,
): TokenPayload | undefined {
  const token = toCodexToken(tokenCount, taskStarted, cachedContextWindow)
  if (!token) return undefined
  if (!token.rateLimits && tokenCountWithLimits && tokenCountWithLimits !== tokenCount) {
    const withLimits = toCodexToken(tokenCountWithLimits, taskStarted, cachedContextWindow)
    if (withLimits?.rateLimits) {
      token.rateLimits = withLimits.rateLimits
      token.rateLimitId = withLimits.rateLimitId
      token.rateLimitName = withLimits.rateLimitName
    }
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
  outcome: 'completed' | 'aborted'
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
 * @param taskType Native terminal event kind.
 * @returns A terminal duration record, or `undefined` when native timing is unusable.

 */
function readCodexTaskTerminal(
  payload: Record<string, unknown>,
  envelope: Record<string, unknown>,
  taskType: 'task_complete' | 'turn_aborted',
): CodexTaskTerminal | undefined {
  const observedAt =
    parseRolloutTimestamp(payload.completed_at) ?? parseRolloutTimestamp(envelope.timestamp)
  const elapsedMs = optionalNumber(payload.duration_ms) ?? optionalNumber(payload.durationMs)
  if (observedAt == null || observedAt <= 0 || elapsedMs == null || elapsedMs < 0) return undefined
  return {
    outcome: taskType === 'task_complete' ? 'completed' : 'aborted',
    turnId: readString(payload, 'turn_id', 'turnId'),
    elapsedMs,
    observedAt,
  }
}

/**
 * Picks one card-level timing value from a rollout that may include nested
 * tasks. A start with a stable turn ID remains active until a terminal record
 * with the same ID appears, even when a newer nested task has already ended.
 * Unidentified starts cannot be paired safely, so only those newer than the
 * latest terminal are eligible. The newest remaining start represents the card.
 *
 * @param activeTasks Unmatched native task starts from the rollout tail.
 * @param latestTerminalTask Newest native completion or abort from the rollout tail.
 * @returns The timing snapshot suitable for the project card, when available.

 */
function selectCodexTurnTiming(
  activeTasks: readonly CodexTaskStart[],
  latestTerminalTask: CodexTaskTerminal | undefined,
): TurnTiming | undefined {
  const currentTasks = activeTasks.filter(
    (candidate) =>
      candidate.turnId != null ||
      latestTerminalTask == null ||
      candidate.startedAt >= latestTerminalTask.observedAt,
  )
  const active = currentTasks.reduce<CodexTaskStart | undefined>(
    (latest, candidate) => (!latest || candidate.startedAt > latest.startedAt ? candidate : latest),
    undefined,
  )
  if (active) {
    return {
      state: 'active',
      ...(active.turnId ? { externalTurnId: active.turnId } : {}),
      startedAt: active.startedAt,
      observedAt: active.startedAt,
    }
  }
  if (!latestTerminalTask) return undefined
  return {
    state: 'completed',
    ...(latestTerminalTask.turnId ? { externalTurnId: latestTerminalTask.turnId } : {}),
    ...(latestTerminalTask.outcome === 'aborted' ? { outcome: 'cancelled' as const } : {}),
    ...(latestTerminalTask.startedAt !== undefined
      ? { startedAt: latestTerminalTask.startedAt }
      : {}),
    elapsedMs: latestTerminalTask.elapsedMs,
    observedAt: latestTerminalTask.observedAt,
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
 * Builds a stable fallback identity for quota rows that omit envelope time.
 *
 * @param payload Native quota-bearing `token_count` payload.
 * @returns Deterministic safe integer derived from its quota JSON content.

 */
function deterministicQuotaObservationId(payload: Record<string, unknown>): number {
  const info = isRecord(payload.info) ? payload.info : undefined
  const serialized = JSON.stringify(payload.rate_limits ?? info?.rate_limits ?? {})
  let hash = 2_166_136_261
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  return hash >>> 0
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

/**
 * Computes token count payload has rate limits.
 * @param payload Native Codex token-count payload.
 * @returns Whether the payload carries any quota window.
 */
function tokenCountPayloadHasRateLimits(payload: Record<string, unknown>): boolean {
  const info = isRecord(payload.info) ? payload.info : undefined
  const raw = payload.rate_limits ?? info?.rate_limits
  if (!isRecord(raw)) return false
  return Boolean(
    raw.primary || raw.secondary || raw.five_hour || raw.fiveHour || raw.seven_day || raw.sevenDay,
  )
}

/**
 * Streams complete JSONL rows from newest to oldest using bounded disk reads.
 *
 * Blocks never overlap. Buffered row fragments join the oldest partial row in
 * a newer block to its prefix in older blocks, so both long lines and UTF-8
 * code points split at a boundary remain intact. Fragments are concatenated
 * only once, when their newline is found, avoiding quadratic copies for large
 * tool-output rows. A row cut by the scan budget is discarded rather than parsed.
 *
 * @param file Absolute rollout JSONL path.
 * @param options Reverse scan bounds plus an optional diagnostics callback.
 * @returns Async generator yielding complete JSONL rows in reverse chronological order.

 */
async function* readRolloutRowsReverse(
  file: string,
  options: {
    chunkBytes?: number
    maxBytes?: number
    onBytesRead?: (totalBytes: number) => void
  } = {},
): AsyncGenerator<{ data: Buffer; startOffset: number }> {
  const handle = await open(file, 'r')
  try {
    const chunkBytes = options.chunkBytes ?? ROLLOUT_SCAN_CHUNK_BYTES
    const maxBytes = options.maxBytes ?? MAX_ROLLOUT_SCAN_BYTES
    const size = (await handle.stat()).size
    const scanStart = Math.max(0, size - Math.max(1, maxBytes))
    const blockSize = Math.max(1, chunkBytes)
    let cursor = size
    let carriedParts: Buffer[] = []
    let totalBytesRead = 0

    while (cursor > scanStart) {
      const blockStart = Math.max(scanStart, cursor - blockSize)
      const length = cursor - blockStart
      const block = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(block, 0, length, blockStart)
      totalBytesRead += bytesRead
      options.onBytesRead?.(totalBytesRead)
      // Rollouts are append-only. A short positional read means the file was
      // replaced/truncated mid-scan; stop and let the next refresh retry it.
      if (bytesRead !== length) break

      let lineEnd = block.length
      let foundBoundary = false
      for (let index = block.length - 1; index >= 0; index -= 1) {
        if (block[index] !== 0x0a) continue
        const ownPart = block.subarray(index + 1, lineEnd)
        const line = assembleRolloutLine(
          foundBoundary || carriedParts.length === 0 ? [ownPart] : [ownPart, ...carriedParts],
        )
        if (line !== undefined) {
          yield { data: line, startOffset: blockStart + index + 1 }
        }
        foundBoundary = true
        carriedParts = []
        lineEnd = index
      }

      const oldestPart = block.subarray(0, lineEnd)
      if (foundBoundary) {
        carriedParts = oldestPart.length > 0 ? [Buffer.from(oldestPart)] : []
      } else {
        // Prepend without joining: a multi-megabyte row is copied only once,
        // after an older block finally supplies its leading newline.
        carriedParts.unshift(block)
      }
      cursor = blockStart
    }

    if (scanStart === 0 && carriedParts.length > 0) {
      const line = assembleRolloutLine(carriedParts)
      if (line !== undefined) yield { data: line, startOffset: 0 }
    }
  } finally {
    await handle.close()
  }
}

/**
 * Joins one complete JSONL row assembled by the reverse scanner.
 *
 * Keeping the row as bytes lets callers reject irrelevant tool output before
 * UTF-8 decoding, and preserves code points that straddle two disk blocks.
 *
 * @param parts Row byte fragments in chronological order.
 * @returns Row bytes without the optional carriage return, or `undefined` for an empty row.

 */
function assembleRolloutLine(parts: readonly Buffer[]): Buffer | undefined {
  const byteLength = parts.reduce((total, part) => total + part.length, 0)
  if (byteLength === 0) return undefined
  const row = parts.length === 1 ? parts[0] : Buffer.concat(parts, byteLength)
  const contentEnd = row[row.length - 1] === 0x0d ? row.length - 1 : row.length
  return contentEnd > 0 ? row.subarray(0, contentEnd) : undefined
}

/**
 * Converts native Codex token-count fields into the shared token payload.
 *
 * @param tokenCount Native `token_count` event payload.
 * @param taskStarted Optional task metadata containing a context-window fallback.
 * @param cachedContextWindow Model-specific window read from the Codex model cache.
 * @returns Normalized token data, or `undefined` when the event has no usable fields.

 */
function toCodexToken(
  tokenCount: Record<string, unknown>,
  taskStarted: Record<string, unknown> | undefined,
  cachedContextWindow: number | undefined,
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
    positiveNumber(info.model_context_window) ??
    positiveNumber(taskStarted?.model_context_window) ??
    cachedContextWindow ??
    positiveNumber(process.env.CODEPULSE_CODEX_CONTEXT_WINDOW)
  const contextInput =
    optionalNumber(contextUsage?.input_tokens) ?? optionalNumber(contextUsage?.cached_input_tokens)
  const contextUsedPercent =
    contextUsage && contextWindow && contextInput !== undefined
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
    accuracy: 'exact',
  }
}

/**
 * Reads usage.
 * @param value Native usage object.
 * @returns Normalized usage counters, or `undefined` when absent.
 */
function readUsage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/**
 * Normalizes rate limits.
 * @param value Native rate-limit payload.
 * @returns Normalized quota windows, or `undefined` when unusable.
 */
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

/**
 * Classifies primary secondary windows.
 * @param primary Primary native quota window.
 * @param secondary Secondary native quota window.
 * @returns Shared five-hour and weekly window assignment.
 */
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

/**
 * Classifies window kind.
 * @param window Quota window to process.
 * @returns Shared window kind inferred from duration metadata.
 */
function classifyWindowKind(
  window: NonNullable<RateLimitWindow>,
): 'fiveHour' | 'sevenDay' | 'unknown' {
  const minutes = window.windowMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'unknown'
  if (minutes <= 24 * 60) return 'fiveHour'
  return 'sevenDay'
}

/**
 * Normalizes window.
 * @param value Native quota-window payload.
 * @returns Normalized quota window, or `undefined` when invalid.
 */
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

/**
 * Reads rate limit string.
 * @param value Value to inspect.
 * @param keys Candidate native field names in priority order.
 * @returns First non-empty string found under the candidate keys.
 */
function readRateLimitString(value: unknown, ...keys: string[]): string | undefined {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  for (const key of keys) {
    const item = raw[key]
    if (typeof item === 'string' && item.length > 0) return item
  }
  return undefined
}

/**
 * Resets windows.
 * @param token Token payload to process.
 * @returns Quota windows with expired reset metadata removed.
 */
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


 * @param token Token payload to process.
 * @param window Quota window to process.
 * @param scheduledResetAt Reset boundary associated with the scheduled read.
 * @returns Whether the condition is satisfied.
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

/**
 * Normalizes reset at.
 * @param value Value to inspect.
 * @returns Reset time in epoch milliseconds, or `undefined` when invalid.
 */
function normalizeResetAt(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

/**
 * Computes optional number.
 * @param value Value to inspect.
 * @returns Finite numeric value, or `undefined`.
 */
function optionalNumber(value: unknown): number | undefined {
  return parseTokenCount(value)
}

/**
 * Parses a strictly positive token count for use as a context-window denominator.
 *
 * @param value Native or configured context-window value.
 * @returns Positive token count, or `undefined` when missing or invalid.

 */
function positiveNumber(value: unknown): number | undefined {
  const parsed = optionalNumber(value)
  return parsed !== undefined && parsed > 0 ? parsed : undefined
}

/**
 * Checks whether record.
 * @param value Value to inspect.
 * @returns Whether the condition is satisfied.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * CodePulse 核心的纯 reducer。给定某 agent 的当前运行时状态与一个
 * 归一化事件，按需求 §8 的迁移表计算下一个运行时状态。
 *
 * reducer 刻意保持无副作用，因而易于单元测试，
 * 同一逻辑也可运行在任何上下文（主进程、服务器、测试）。
 *
 * @module core/state-machine
 */
import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type TokenRateLimitWindow,
  type TurnTiming,
  TurnState,
  isActiveState,
  isTerminalState,
  normalizeWorkspacePath,
} from '@codepulse/shared'

/**
 * 为尚未上报过的 agent 构建初始空闲运行时状态。
 *
 * @param agentType 要创建状态槽位的 agent。
 * @returns 处于 `IDLE` 状态的全新 {@link AgentRuntimeState}。
 */
export function createInitialRuntimeState(agentType: AgentType): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    lastEventAt: 0,
    unread: false,
  }
}

/**
 * 通过 {@link reduce} 投喂一个事件后的结果。
 */
export interface TransitionResult {
  /** Event-time runtime state before applying the reducer. */
  previous: AgentRuntimeState
  /** 应用事件后的新运行时状态。 */
  next: AgentRuntimeState
  /** 该事件是否首次把轮次带入终结状态。 */
  turnEnded: boolean
  /** 事件发生前 agent 所处的状态。 */
  previousState: TurnState
}

/**
 * 把一个事件应用到 agent 的运行时状态上。
 *
 * 纯函数：从不修改 `current`，也不产生副作用。返回的
 * {@link TransitionResult} 还会报告之前的状态以及轮次是否刚刚结束，
 * 供规则引擎决定通知。
 *
 * 公共上下文字段（会话/轮次 id、工作区、模型、token 用量）
 * 不论事件种类，只要事件携带就会被继承更新。
 *
 * @param current agent 现有的运行时状态。
 * @param event 待应用的归一化事件。
 * @returns 下一个状态及迁移元数据。
 */
export function reduce(current: AgentRuntimeState, event: AgentEvent): TransitionResult {
  const previousState = current.state
  const tokenOnlyQuotaRefresh = event.internal?.quotaRefresh === true
  const deferSynchronizedTurnIdentity =
    !tokenOnlyQuotaRefresh && event.internal?.sessionSync === true && event.turnTiming != null
  const next: AgentRuntimeState = {
    ...current,
    lastEventAt:
      event.eventType === 'turn_timeout' || tokenOnlyQuotaRefresh
        ? current.lastEventAt
        : event.timestamp,
  }

  // 继承事件经常刷新的上下文字段。
  if (!tokenOnlyQuotaRefresh) {
    if (event.externalSessionId) next.externalSessionId = event.externalSessionId
    if (!deferSynchronizedTurnIdentity && shouldAdoptExternalTurnId(current, event)) {
      next.externalTurnId = event.externalTurnId
    }
    // Prefer the project root over tool-hook subdirectory cwd values.
    const incomingWorkspace = event.workspacePath ?? event.cwd
    if (incomingWorkspace) {
      next.workspacePath = preferWorkspacePath(current.workspacePath, incomingWorkspace)
    }
    applyModelConfiguration(current, next, event)
  }
  const acceptedTurnTiming = tokenOnlyQuotaRefresh
    ? undefined
    : applyTurnTimingSnapshot(current, next, event)
  if (deferSynchronizedTurnIdentity && acceptedTurnTiming?.externalTurnId) {
    const acceptedIdentityEvent = {
      ...event,
      externalTurnId: acceptedTurnTiming.externalTurnId,
    }
    if (shouldAdoptExternalTurnId(current, acceptedIdentityEvent)) {
      next.externalTurnId = acceptedTurnTiming.externalTurnId
    }
  }
  if (event.token) {
    // Use the accepted runtime model, not the raw event model. A stale rollout
    // snapshot must not affect quota-family selection after it was rejected above.
    next.token = mergeToken(current.token, event.token, event.timestamp, next.model)
  }
  // Real activity unhides idle-pruned project cards. Pure quota refreshes do not.
  if (!tokenOnlyQuotaRefresh) {
    if (event.eventType !== 'token_snapshot') next.taskHidden = false
    else if (event.internal?.sessionSync) {
      next.taskHidden = false
      // Disk activity while still IDLE restarts the 5-minute idle retention clock.
      if (next.state === TurnState.IDLE) next.terminalAt = event.timestamp
    }
  }

  switch (event.eventType) {
    case 'session_start':
      // Duplicate or delayed startup hooks must not erase an in-flight turn.
      if (isActiveState(current.state) || current.state === TurnState.TIMEOUT) break
      next.state = TurnState.IDLE
      next.unread = false
      // Count idle retention from first sighting so disk-hydrated cards expire in 5 min.
      next.terminalAt = event.timestamp
      if (!hasContextSnapshot(event.token)) next.token = markContextStale(next.token)
      reconcileSynchronizedTimingLifecycle(current, next, event, acceptedTurnTiming)
      break

    case 'prompt_submit':
      next.state = TurnState.PROMPT_SUBMITTED
      // The prompt turn is the user-visible root turn. Tool/subagent events may
      // carry different turn IDs and must not replace this completion anchor.
      next.externalTurnId = event.externalTurnId
      applyPromptTiming(next, acceptedTurnTiming, event.timestamp)
      next.toolCallCount = 0
      next.needPermission = false
      next.needUserInput = false
      next.unread = false
      next.terminalAt = undefined
      next.activity = 'AI 正在处理任务'
      next.lastAssistantMessage = undefined
      // Privacy-friendly prompt preview from hooks — used for completion toast copy.
      if (event.message) next.lastUserPrompt = event.message
      break

    case 'tool_start':
      next.state = TurnState.TOOL_RUNNING
      next.toolName = event.toolName
      next.toolCallCount = current.toolCallCount + 1
      next.terminalAt = undefined
      next.activity = describeTool(event)
      break

    case 'tool_end':
      // 回到思考状态，直到下一个信号；保持轮次存活。
      next.state = TurnState.THINKING
      next.toolName = undefined
      next.terminalAt = undefined
      next.activity = 'AI 正在生成响应'
      break

    case 'permission_request':
      next.state = TurnState.WAITING_PERMISSION
      next.needPermission = true
      next.terminalAt = undefined
      next.activity = event.message ?? describeTool(event) ?? '等待用户授权'
      break

    case 'user_input_required':
      next.state = TurnState.WAITING_USER_INPUT
      next.needUserInput = true
      next.terminalAt = undefined
      next.activity = event.message ?? '等待用户继续输入'
      break

    case 'turn_stop':
      // A Stop for a nested/different turn does not complete the user's root
      // turn. Likewise, a late Stop must not overwrite error, cancel, limit, or
      // timeout states with a misleading successful completion.
      if (!isActiveState(current.state) || isForeignTurnEvent(current, event)) break
      next.state = TurnState.DONE
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.terminalAt = event.timestamp
      next.activity = '本轮任务已完成'
      next.unread = true
      if (event.message) next.lastAssistantMessage = event.message
      break

    case 'turn_error':
      if (isForeignTurnEvent(current, event)) break
      next.state = TurnState.ERROR
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.terminalAt = event.timestamp
      next.activity = event.message ?? '任务执行出错'
      next.unread = true
      break

    case 'turn_cancelled':
      if (isForeignTurnEvent(current, event)) break
      next.state = TurnState.CANCELLED
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.terminalAt = event.timestamp
      next.activity = event.message ?? '任务已取消'
      next.unread = true
      break

    case 'turn_timeout':
      next.state = TurnState.TIMEOUT
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.terminalAt = event.timestamp
      next.activity = event.message ?? '疑似卡住'
      next.unread = true
      break

    case 'usage_limited':
      if (isForeignTurnEvent(current, event)) break
      next.state = TurnState.USAGE_LIMITED
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.terminalAt = event.timestamp
      next.activity = '已达用量上限，任务暂时停止'
      next.unread = true
      break

    case 'token_snapshot':
      // Token-only data normally leaves lifecycle untouched. A local CLI timing
      // snapshot is the exception: it can recover an in-flight turn after the
      // desktop/server restarts, or close one that the hook stream missed.
      reconcileSynchronizedTimingLifecycle(current, next, event, acceptedTurnTiming)
      break

    case 'session_end':
      if (isForeignTurnEvent(current, event)) break
      next.state = TurnState.IDLE
      next.turnStartedAt = undefined
      next.turnTiming = completeTurnTiming(current, acceptedTurnTiming, event.timestamp)
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.activity = undefined
      // Start the 5-minute idle retention clock when the session ends.
      next.terminalAt = event.timestamp
      if (!hasContextSnapshot(event.token)) next.token = markContextStale(next.token)
      break

    default:
      assertNever(event.eventType)
  }

  return {
    previous: current,
    next,
    turnEnded: isTerminalState(next.state) && !isTerminalState(previousState),
    previousState,
  }
}

/**
 * Decides whether an event may replace the user-visible root turn identifier.
 *
 * Codex gives nested tool/subagent work its own turn IDs while retaining the
 * parent session ID. Once a prompt establishes the root turn, those nested IDs
 * must not replace it; otherwise a nested Stop can look like root completion.
 * A new activity event may establish a turn after a terminal state when the
 * corresponding prompt hook was missed.
 *
 * @param current Runtime state before the event.
 * @param event Incoming normalized lifecycle event.
 * @returns Whether `event.externalTurnId` should become the runtime turn ID.
 */
function shouldAdoptExternalTurnId(current: AgentRuntimeState, event: AgentEvent): boolean {
  const incoming = event.externalTurnId
  if (!incoming) return false
  if (event.eventType === 'prompt_submit') return true
  // A timed-out turn retains its root identity until an explicit new prompt.
  // Nested activity may prove liveness, but it cannot claim the root turn.
  if (current.state === TurnState.TIMEOUT) return incoming === current.externalTurnId
  if (event.eventType === 'session_start') return !isActiveState(current.state)
  if (incoming === current.externalTurnId) return true
  // During an already-active turn, a late tool/subagent event cannot safely
  // establish or replace the root identity. After a terminal state, fresh
  // activity may establish a new turn when its prompt hook was missed.
  return !isActiveState(current.state) && isTurnActivityEvent(event)
}

/**
 * Reports whether an event proves that a turn is actively progressing.
 *
 * @param event Incoming normalized event.
 * @returns `true` for lifecycle events that start or continue active work.
 */
function isTurnActivityEvent(event: AgentEvent): boolean {
  return (
    event.eventType === 'prompt_submit' ||
    event.eventType === 'tool_start' ||
    event.eventType === 'tool_end' ||
    event.eventType === 'permission_request' ||
    event.eventType === 'user_input_required' ||
    (event.eventType === 'token_snapshot' && event.turnTiming?.state === 'active')
  )
}

/**
 * Detects a terminal event belonging to nested work rather than the root turn.
 *
 * @param current Runtime state anchored to the latest user prompt turn.
 * @param event Candidate terminal event.
 * @returns `true` when both IDs exist and identify different turns.
 */
function isForeignTurnEvent(current: AgentRuntimeState, event: AgentEvent): boolean {
  if (!current.externalTurnId && !event.externalTurnId) return false
  return current.externalTurnId !== event.externalTurnId
}

/**
 * Applies a timestamped native CLI timing snapshot when it is newer than the
 * timing currently held by the runtime. The event timestamp is deliberately
 * not used as the task start because session synchronization is intermittent.
 *
 * @param current Runtime state before the event.
 * @param next Mutable runtime state being constructed.
 * @param event Normalized event that may carry native timing metadata.
 * @returns The accepted sanitized timing snapshot, if any.
 */
function applyTurnTimingSnapshot(
  current: AgentRuntimeState,
  next: AgentRuntimeState,
  event: AgentEvent,
): TurnTiming | undefined {
  const incoming = sanitizeTurnTiming(event.turnTiming)
  if (!incoming) return undefined
  if (
    event.internal?.sessionSync === true &&
    !canSynchronizedCompletionEndActiveTurn(current, incoming)
  ) {
    return undefined
  }
  if (
    event.internal?.sessionSync === true &&
    isForeignTurnTiming(current, incoming) &&
    (isActiveState(current.state) ||
      current.state === TurnState.TIMEOUT ||
      incoming.state !== 'active')
  ) {
    return undefined
  }
  if (
    current.state === TurnState.TIMEOUT &&
    incoming.state === 'active' &&
    !canRecoverTimedOutTurnFromFreshSync(current, event, incoming)
  ) {
    return undefined
  }

  const existingObservedAt = current.turnTiming?.observedAt ?? current.turnStartedAt
  if (
    existingObservedAt != null &&
    incoming.observedAt < existingObservedAt &&
    !isNativeCompletionForCurrentTurn(current.turnTiming, incoming) &&
    !isIdentifiedCompletionForActiveRoot(current, incoming) &&
    !canRecoverTimedOutTurnFromFreshSync(current, event, incoming)
  ) {
    return undefined
  }
  if (
    existingObservedAt === incoming.observedAt &&
    current.turnTiming?.state === 'completed' &&
    incoming.state === 'active'
  ) {
    return undefined
  }

  next.turnTiming = incoming
  next.turnStartedAt = incoming.state === 'active' ? incoming.startedAt : undefined
  return incoming
}

/** Maximum start-time drift accepted when a CLI exposes no stable turn ID. */
const SYNCHRONIZED_START_MATCH_TOLERANCE_MS = 5_000

/**
 * Verifies that a native terminal snapshot belongs to the visible active turn.
 *
 * A stable root ID is authoritative. For older CLIs without IDs, the native
 * start must closely match the prompt start. Ambiguous or explicitly unsafe
 * durations remain displayable while idle but cannot trigger a notification.
 *
 * @param current Runtime state anchored to the visible turn.
 * @param incoming Sanitized native timing snapshot.
 * @returns Whether the snapshot may drive an active-to-terminal transition.
 */
function canSynchronizedCompletionEndActiveTurn(
  current: AgentRuntimeState,
  incoming: TurnTiming,
): boolean {
  if (!isActiveState(current.state) || incoming.state !== 'completed') return true
  if (incoming.canEndActiveTurn === false) return false
  if (current.externalTurnId) return incoming.externalTurnId === current.externalTurnId
  // An ID that appeared only after an ID-less prompt may belong to nested work.
  // Do not promote it to the root merely because its start time is nearby.
  if (incoming.externalTurnId) return false

  const currentStartedAt = current.turnStartedAt ?? current.turnTiming?.startedAt
  return Boolean(
    currentStartedAt != null &&
    incoming.startedAt != null &&
    Math.abs(currentStartedAt - incoming.startedAt) <= SYNCHRONIZED_START_MATCH_TOLERANCE_MS,
  )
}

/**
 * Accepts a delayed native terminal snapshot for the exact active root turn.
 *
 * Hook delivery can lag the CLI's persisted completion timestamp by a few
 * milliseconds. A stable matching turn ID is stronger evidence than timestamp
 * ordering and prevents the already-finished turn from later timing out.
 *
 * @param current Active runtime anchored to a user-visible root turn.
 * @param incoming Candidate native timing snapshot.
 * @returns `true` only for an identified completion of that same root turn.
 */
function isIdentifiedCompletionForActiveRoot(
  current: AgentRuntimeState,
  incoming: TurnTiming,
): boolean {
  return Boolean(
    isActiveState(current.state) &&
    incoming.state === 'completed' &&
    current.externalTurnId &&
    incoming.externalTurnId === current.externalTurnId,
  )
}

/**
 * Allows a real local file/session update to revive a previously timed-out turn.
 *
 * A static persisted `active` record is intentionally not enough: it may be an
 * abandoned CLI session. The session synchronizer marks this path only after a
 * rollout, transcript, or per-session data file changed since its prior scan.
 *
 * @param current Runtime state before the incoming timing snapshot.
 * @param event Event carrying local synchronization metadata.
 * @param incoming Candidate native timing snapshot.
 * @returns `true` when the timeout can safely be replaced with active work.
 */
function canRecoverTimedOutTurnFromFreshSync(
  current: AgentRuntimeState,
  event: AgentEvent,
  incoming: TurnTiming,
): boolean {
  if (
    current.state !== TurnState.TIMEOUT ||
    incoming.state !== 'active' ||
    event.internal?.sessionSync !== true ||
    event.internal.activityRefresh !== true
  ) {
    return false
  }
  if (current.externalTurnId) return incoming.externalTurnId === current.externalTurnId
  if (incoming.externalTurnId) return false

  const timedOutStartedAt = current.turnTiming?.startedAt
  return Boolean(
    timedOutStartedAt != null &&
    incoming.startedAt != null &&
    Math.abs(timedOutStartedAt - incoming.startedAt) <= SYNCHRONIZED_START_MATCH_TOLERANCE_MS,
  )
}

/**
 * Allows a CLI-completed duration to refine the reducer's approximate hook
 * duration for the same turn. Native completion time can precede the hook's
 * delivery time, so a strict observation-time comparison would reject it.
 *
 * @param current Existing runtime timing snapshot.
 * @param incoming Candidate native CLI timing snapshot.
 * @returns `true` when the candidate is a completion for the same observed turn.
 */
function isNativeCompletionForCurrentTurn(
  current: TurnTiming | undefined,
  incoming: TurnTiming,
): boolean {
  if (current?.state !== 'completed' || incoming.state !== 'completed') return false
  if (current.startedAt != null && incoming.startedAt != null) {
    return Math.abs(current.startedAt - incoming.startedAt) <= 2_000
  }

  // Claude's native `turn_duration` does not reliably identify the matching
  // prompt. A hook-derived completion is recognizable because its elapsed value
  // is exactly its hook receive time minus the remembered start. Allow a nearby
  // CLI completion to replace that approximation even without a safe start ID.
  return (
    isHookDerivedCompletion(current) &&
    incoming.observedAt <= current.observedAt &&
    current.observedAt - incoming.observedAt <= 90_000
  )
}

/**
 * Checks whether a completed timing value was calculated from a hook timestamp.
 *
 * Hook terminal events have no native duration, so {@link completeTurnTiming}
 * stores precisely `observedAt - startedAt`. Native CLI durations are often a
 * few milliseconds different and must be allowed to refine this approximation.
 *
 * @param timing Completed timing value to inspect.
 * @returns `true` when the duration has the reducer's hook-derived shape.
 */
function isHookDerivedCompletion(timing: TurnTiming): boolean {
  return (
    timing.startedAt != null &&
    timing.elapsedMs != null &&
    timing.elapsedMs === Math.max(0, timing.observedAt - timing.startedAt)
  )
}

/**
 * Starts a turn using accepted CLI timing when available, otherwise the hook
 * observation time. A new prompt always clears the prior completed duration.
 *
 * @param next Mutable runtime state being constructed.
 * @param timing Accepted native timing snapshot for this event, if any.
 * @param observedAt Hook event observation time in epoch milliseconds.
 */
function applyPromptTiming(
  next: AgentRuntimeState,
  timing: TurnTiming | undefined,
  observedAt: number,
): void {
  const startedAt = timing?.state === 'active' ? timing.startedAt : undefined
  const effectiveStart = startedAt ?? observedAt
  next.turnStartedAt = effectiveStart
  next.turnTiming = {
    state: 'active',
    startedAt: effectiveStart,
    observedAt: timing?.state === 'active' ? timing.observedAt : observedAt,
  }
}

/**
 * Freezes the elapsed time when a lifecycle event ends a task. Native completed
 * snapshots win; otherwise the reducer derives a duration from the remembered
 * active start time and preserves an already completed snapshot when no start
 * was ever observed.
 *
 * @param current Runtime state before the terminal event.
 * @param timing Accepted native timing snapshot for this event, if any.
 * @param endedAt Terminal event observation time in epoch milliseconds.
 * @returns The timing snapshot to retain on the completed runtime card.
 */
function completeTurnTiming(
  current: AgentRuntimeState,
  timing: TurnTiming | undefined,
  endedAt: number,
): TurnTiming | undefined {
  if (timing?.state === 'completed') return timing

  const startedAt = current.turnStartedAt ?? current.turnTiming?.startedAt
  if (isEpochMilliseconds(startedAt)) {
    return {
      state: 'completed',
      startedAt,
      elapsedMs: Math.max(0, endedAt - startedAt),
      observedAt: endedAt,
    }
  }
  return current.turnTiming?.state === 'completed' ? current.turnTiming : undefined
}

/**
 * Reconciles a trusted local-session timing snapshot with the visible lifecycle.
 *
 * Session hydration intentionally begins as `IDLE` so merely opening a CLI does
 * not look like work. When the CLI's own session data says a turn is active,
 * however, the card must be restored as active and must not enter idle pruning.
 * Conversely, a newly observed native completion closes a currently active card
 * without overriding a more specific hook terminal result such as `ERROR`.
 *
 * @param current Runtime state before the synchronized event.
 * @param next Mutable runtime state being built for the synchronized event.
 * @param event Event carrying the local session synchronization marker.
 * @param timing Accepted native timing snapshot, if it passed freshness checks.
 */
function reconcileSynchronizedTimingLifecycle(
  current: AgentRuntimeState,
  next: AgentRuntimeState,
  event: AgentEvent,
  timing: TurnTiming | undefined,
): void {
  if (event.internal?.sessionSync !== true || !timing) return

  if (timing.state === 'active') {
    if (!isActiveState(next.state)) {
      next.state = TurnState.PROMPT_SUBMITTED
      next.toolCallCount = 0
      next.needPermission = false
      next.needUserInput = false
      next.toolName = undefined
      next.unread = false
      next.activity = 'AI 正在处理任务'
      next.lastAssistantMessage = undefined
    }
    // A native active observation is a liveness heartbeat, never an idle card.
    next.terminalAt = undefined
    return
  }

  if (!isActiveState(current.state)) return
  const cancelled = timing.outcome === 'cancelled'
  next.state = cancelled ? TurnState.CANCELLED : TurnState.DONE
  next.turnStartedAt = undefined
  next.needPermission = false
  next.needUserInput = false
  next.toolName = undefined
  next.terminalAt = Math.min(event.timestamp, timing.observedAt)
  next.activity = cancelled ? '任务已取消' : '本轮任务已完成'
  next.unread = true
}

/**
 * Validates an untrusted timing snapshot from a local hook or the local HTTP API.
 *
 * @param timing Candidate native timing snapshot.
 * @returns A normalized timing snapshot, or `undefined` when it is malformed.
 */
function sanitizeTurnTiming(timing: TurnTiming | undefined): TurnTiming | undefined {
  if (!timing || (timing.state !== 'active' && timing.state !== 'completed')) return undefined
  if (!isEpochMilliseconds(timing.observedAt)) return undefined

  const startedAt = isEpochMilliseconds(timing.startedAt) ? timing.startedAt : undefined
  const elapsedMs = isNonNegativeFinite(timing.elapsedMs) ? timing.elapsedMs : undefined
  if (timing.state === 'active' && startedAt === undefined) return undefined
  if (timing.state === 'completed' && elapsedMs === undefined) return undefined

  return {
    state: timing.state,
    ...(typeof timing.externalTurnId === 'string' && timing.externalTurnId.trim()
      ? { externalTurnId: timing.externalTurnId.trim() }
      : {}),
    ...(typeof timing.canEndActiveTurn === 'boolean'
      ? { canEndActiveTurn: timing.canEndActiveTurn }
      : {}),
    ...(timing.outcome === 'completed' || timing.outcome === 'cancelled'
      ? { outcome: timing.outcome }
      : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    observedAt: timing.observedAt,
  }
}

/**
 * Detects native timing for a nested task rather than the visible root turn.
 *
 * @param current Runtime state anchored to the latest user prompt.
 * @param timing Sanitized native CLI timing snapshot.
 * @returns `true` when both identifiers exist and do not match.
 */
function isForeignTurnTiming(current: AgentRuntimeState, timing: TurnTiming): boolean {
  return Boolean(
    current.externalTurnId &&
    timing.externalTurnId &&
    current.externalTurnId !== timing.externalTurnId,
  )
}

/**
 * Checks whether a value is a plausible positive epoch-millisecond timestamp.
 *
 * @param value Candidate timestamp.
 * @returns `true` when the value is finite and positive.
 */
function isEpochMilliseconds(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Checks whether a value is a usable duration in milliseconds.
 *
 * @param value Candidate duration.
 * @returns `true` when the value is finite and not negative.
 */
function isNonNegativeFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Applies model and reasoning-depth configuration while protecting a verified
 * Codex rollout snapshot from late, less-specific hook metadata.
 *
 * Codex records the model and its reasoning effort together in a `turn_context`.
 * Once that timestamped snapshot exists, an unversioned hook model cannot replace
 * it. Newer snapshots replace both fields atomically so an old effort never remains
 * paired with a new model. Claude can also report its global thinking-depth setting
 * independently, so that setting has its own observation timestamp.
 *
 * @param current Runtime state before the event.
 * @param next Mutable copy of the runtime state being built by the reducer.
 * @param event Normalized incoming event.
 */
function applyModelConfiguration(
  current: AgentRuntimeState,
  next: AgentRuntimeState,
  event: AgentEvent,
): void {
  const observedAt = event.modelObservedAt
  let acceptedModelSnapshot = false
  let rejectedModelSnapshot = false

  if (observedAt !== undefined && event.model) {
    if (current.modelObservedAt === undefined || observedAt >= current.modelObservedAt) {
      next.model = event.model
      next.modelObservedAt = observedAt
      acceptedModelSnapshot = true
    } else {
      rejectedModelSnapshot = true
    }
  } else if (!(event.source === 'codex' && current.modelObservedAt !== undefined)) {
    // Native Codex hooks may carry a stale top-level model. Once a timestamped
    // rollout configuration is known, wait for another rollout snapshot to change it.
    if (event.model) next.model = event.model
  }

  if (event.reasoningEffortObservedAt !== undefined) {
    applyReasoningEffortSnapshot(
      current,
      next,
      event.reasoningEffort,
      event.reasoningEffortObservedAt,
    )
    return
  }

  if (acceptedModelSnapshot && observedAt !== undefined) {
    // Deliberately assign undefined too: an effort omitted by the newest model
    // snapshot is unknown, rather than evidence that the previous effort remains.
    applyReasoningEffortSnapshot(current, next, event.reasoningEffort, observedAt)
    return
  }

  // An unversioned event can populate an unknown depth, but cannot replace a
  // configuration that a native settings/rollout snapshot has already verified.
  if (
    !rejectedModelSnapshot &&
    event.reasoningEffort &&
    current.reasoningEffortObservedAt === undefined
  ) {
    next.reasoningEffort = event.reasoningEffort
  }
}

/**
 * Applies a timestamped native thinking-depth setting, including an intentional
 * empty value when the current CLI configuration no longer defines one.
 *
 * @param current Runtime state before the event.
 * @param next Mutable copy of the runtime state being built by the reducer.
 * @param reasoningEffort Native effort value, or `undefined` when known absent.
 * @param observedAt Timestamp of the native configuration observation.
 */
function applyReasoningEffortSnapshot(
  current: AgentRuntimeState,
  next: AgentRuntimeState,
  reasoningEffort: string | undefined,
  observedAt: number,
): void {
  if (
    current.reasoningEffortObservedAt !== undefined &&
    observedAt < current.reasoningEffortObservedAt
  ) {
    return
  }
  next.reasoningEffort = reasoningEffort
  next.reasoningEffortObservedAt = observedAt
}

function mergeToken(
  current: TokenPayload | undefined,
  patch: TokenPayload,
  capturedAt: number,
  activeModel?: string,
): TokenPayload {
  const keepExactContext = current?.accuracy === 'exact' && patch.accuracy !== 'exact'
  const applyContextSnapshot = !keepExactContext && shouldApplyContextSnapshot(current, patch)
  const next: TokenPayload = {
    ...current,
    accuracy: bestTokenAccuracy(current?.accuracy, patch.accuracy),
  }

  if (patch.quotaBuckets) {
    next.quotaBuckets = mergeQuotaBuckets(current?.quotaBuckets, patch.quotaBuckets, capturedAt)
  }

  // When context is exact, do not let estimated snapshots clobber usage fields either
  // (avoids totals disagreeing with the exact context bar).
  if (!keepExactContext && (!hasContextSnapshot(patch) || applyContextSnapshot)) {
    if (patch.input !== undefined) next.input = patch.input
    if (patch.cachedInput !== undefined) next.cachedInput = patch.cachedInput
    if (patch.output !== undefined) next.output = patch.output
    if (patch.reasoningOutput !== undefined) next.reasoningOutput = patch.reasoningOutput
    if (patch.total !== undefined) next.total = patch.total
  }
  if (patch.contextUsedPercent !== undefined && applyContextSnapshot) {
    next.contextUsedPercent = patch.contextUsedPercent
    next.contextCompressed = detectContextCompressed(current, patch)
  }
  if (patch.contextWindow !== undefined && applyContextSnapshot)
    next.contextWindow = patch.contextWindow
  if (hasContextSnapshot(patch) && applyContextSnapshot) next.contextStale = false
  if (patch.contextStale !== undefined) next.contextStale = patch.contextStale
  if (patch.contextCompressed !== undefined && patch.contextUsedPercent === undefined) {
    next.contextCompressed = patch.contextCompressed
  }
  if (patch.costUsd !== undefined) next.costUsd = patch.costUsd
  if (patch.rateLimits) {
    // Always accumulate named buckets; top-level display is sticky by family/model.
    next.quotaBuckets = mergeQuotaBucket(next.quotaBuckets, patch, capturedAt)
    if (shouldApplyRateLimitPatch(current, patch, activeModel)) {
      next.rateLimits = mergeRateLimits(current?.rateLimits, patch.rateLimits)
      if (patch.rateLimitId) next.rateLimitId = patch.rateLimitId
      if (patch.rateLimitName) next.rateLimitName = patch.rateLimitName
    }
  }

  return next
}

/** Drop of ≥8pp on the same window size ⇒ treat as CLI context compression. */
const CONTEXT_COMPRESS_DROP_PP = 8

/**
 * Decides whether an incoming context snapshot may replace the visible value.
 *
 * Context occupancy grows monotonically inside one session. Small decreases are
 * parser/read-order noise and remain hidden. A large drop on the same window is
 * treated as CLI context compression, while a material window-size change starts
 * a new comparison cohort.
 *
 * @param current Currently retained token payload.
 * @param patch Incoming token payload.
 * @returns Whether context-coupled usage fields may be applied atomically.
 */
function shouldApplyContextSnapshot(
  current: TokenPayload | undefined,
  patch: TokenPayload,
): boolean {
  const nextPercent = patch.contextUsedPercent
  const currentPercent = current?.contextUsedPercent
  if (nextPercent === undefined || currentPercent === undefined) return true
  if (!Number.isFinite(nextPercent) || !Number.isFinite(currentPercent)) return false

  const currentWindow = current?.contextWindow
  const nextWindow = patch.contextWindow ?? currentWindow
  if (contextWindowChanged(currentWindow, nextWindow)) return true
  if (nextPercent >= currentPercent) return true
  if (patch.contextCompressed === true) return true
  return nextPercent <= currentPercent - CONTEXT_COMPRESS_DROP_PP
}

/**
 * Reports whether two context-window sizes belong to different cohorts.
 *
 * @param currentWindow Retained context-window size.
 * @param nextWindow Incoming context-window size.
 * @returns Whether the sizes differ by more than five percent.
 */
function contextWindowChanged(
  currentWindow: number | undefined,
  nextWindow: number | undefined,
): boolean {
  return Boolean(
    currentWindow != null &&
    nextWindow != null &&
    currentWindow > 0 &&
    nextWindow > 0 &&
    Math.abs(currentWindow - nextWindow) / currentWindow > 0.05,
  )
}

/**
 * Determines whether an accepted context decrease represents compression.
 *
 * @param current Previously retained token payload.
 * @param patch Accepted incoming token payload.
 * @returns Compression marker for the visible context snapshot.
 */
function detectContextCompressed(
  current: TokenPayload | undefined,
  patch: TokenPayload,
): boolean | undefined {
  const prev = current?.contextUsedPercent
  const nextPct = patch.contextUsedPercent
  if (prev == null || nextPct == null || !Number.isFinite(prev) || !Number.isFinite(nextPct)) {
    return current?.contextCompressed
  }
  if (patch.contextCompressed === true) return true

  const prevWindow = current?.contextWindow
  const nextWindow = patch.contextWindow ?? prevWindow
  // Window size change (e.g. 256k → 1M) changes % without compact — not compression.
  if (contextWindowChanged(prevWindow, nextWindow)) {
    return false
  }

  if (nextPct <= prev - CONTEXT_COMPRESS_DROP_PP) return true
  // Growing again after compact → clear the badge.
  if (nextPct > prev + 2) return false
  // Small noise: hold previous compressed flag.
  return current?.contextCompressed
}

function shouldApplyRateLimitPatch(
  current: TokenPayload | undefined,
  patch: TokenPayload,
  activeModel?: string,
): boolean {
  if (!patch.rateLimits) return false
  if (isZeroOnlyRateLimits(patch.rateLimits)) return false
  if (!current?.rateLimits) return true

  const curId = (current.rateLimitId ?? '').toLowerCase()
  const nextId = (patch.rateLimitId ?? '').toLowerCase()
  if (!curId || !nextId) return true
  if (curId === nextId) return true

  const nextSpark = isSparkBucket(nextId, patch.rateLimitName)
  // Model family switched (e.g. to Spark) → allow top-level display to follow.
  if (activeModel && isSparkModelName(activeModel) === nextSpark) return true

  // Different buckets without a matching model switch: keep sticky top-level.
  const curSpark = isSparkBucket(curId, current.rateLimitName)
  return curSpark === nextSpark
}

function isSparkBucket(id: string | undefined, name: string | undefined): boolean {
  const s = `${id ?? ''} ${name ?? ''}`.toLowerCase()
  return s.includes('spark') || s.includes('bengalfox')
}

function isSparkModelName(model: string | undefined): boolean {
  const value = String(model ?? '').toLowerCase()
  return value.includes('spark') || value.includes('bengalfox')
}

function hasContextSnapshot(token: TokenPayload | undefined): boolean {
  return token?.contextUsedPercent !== undefined || token?.contextWindow !== undefined
}

function markContextStale(token: TokenPayload | undefined): TokenPayload | undefined {
  if (!token) return token
  if (!hasContextSnapshot(token)) return token
  if (token.contextStale) return token
  return { ...token, contextStale: true }
}

function mergeQuotaBuckets(
  current: TokenPayload['quotaBuckets'],
  patch: TokenPayload['quotaBuckets'],
  capturedAt: number,
): TokenPayload['quotaBuckets'] {
  if (!patch) return current
  return Object.values(patch).reduce(
    (next, bucket) =>
      mergeQuotaBucket(
        next,
        {
          rateLimitId: bucket.rateLimitId,
          rateLimitName: bucket.rateLimitName,
          rateLimits: bucket.rateLimits,
        },
        bucket.updatedAt ?? capturedAt,
      ),
    current,
  )
}

function mergeQuotaBucket(
  current: TokenPayload['quotaBuckets'],
  patch: Pick<TokenPayload, 'rateLimitId' | 'rateLimitName' | 'rateLimits'>,
  capturedAt: number,
): TokenPayload['quotaBuckets'] {
  if (!patch.rateLimits || isZeroOnlyRateLimits(patch.rateLimits)) return current

  const key = quotaBucketKey(patch.rateLimitId, patch.rateLimitName)
  const existing = current?.[key]
  const rejectedAsOlder = isStrictlyOlderRateLimitPatch(existing?.rateLimits, patch.rateLimits)
  const mergedRateLimits = mergeRateLimits(existing?.rateLimits, patch.rateLimits)
  const quotaChanged = !sameRateLimits(existing?.rateLimits, mergedRateLimits)
  return {
    ...current,
    [key]: {
      rateLimitId: patch.rateLimitId,
      rateLimitName: patch.rateLimitName,
      rateLimits: mergedRateLimits,
      updatedAt: rejectedAsOlder || !quotaChanged ? existing?.updatedAt : capturedAt,
    },
  }
}

/**
 * Reports whether every timestamped window in a patch predates its current window.
 *
 * An older rollout is allowed through some asynchronous refresh paths, but its
 * rate limits are rejected by {@link mergeRateLimitWindow}. Keeping the original
 * bucket timestamp prevents that rejected snapshot from appearing freshly read
 * to downstream quota selection. Missing reset metadata is treated as
 * inconclusive so legitimate same-period observations can still refresh time.
 *
 * @param current Currently retained quota windows.
 * @param patch Incoming quota windows from one snapshot.
 * @returns `true` when the complete comparable patch is strictly older.
 */
function isStrictlyOlderRateLimitPatch(
  current: TokenPayload['rateLimits'],
  patch: TokenPayload['rateLimits'],
): boolean {
  if (!current || !patch) return false

  let compared = false
  for (const key of ['fiveHour', 'sevenDay'] as const) {
    const incomingWindow = patch[key]
    if (!incomingWindow) continue
    const currentReset = normalizeResetAtMs(current[key]?.resetsAt)
    const incomingReset = normalizeResetAtMs(incomingWindow.resetsAt)
    const resetOrder = compareRateLimitResetAt(incomingReset, currentReset)
    if (resetOrder === undefined) return false
    compared = true
    if (resetOrder >= 0) return false
  }
  return compared
}

function quotaBucketKey(
  rateLimitId: string | undefined,
  rateLimitName: string | undefined,
): string {
  return rateLimitId?.trim() || rateLimitName?.trim() || 'default'
}

function bestTokenAccuracy(
  current: TokenPayload['accuracy'] | undefined,
  patch: TokenPayload['accuracy'] | undefined,
): TokenPayload['accuracy'] {
  if (current === 'exact' || patch === 'exact') return 'exact'
  if (current === 'estimated' || patch === 'estimated') return 'estimated'
  return patch ?? current ?? 'unknown'
}

function mergeRateLimits(
  current: TokenPayload['rateLimits'],
  patch: TokenPayload['rateLimits'],
): TokenPayload['rateLimits'] {
  if (!patch) return current
  if (isZeroOnlyRateLimits(patch)) return current
  return {
    fiveHour: mergeRateLimitWindow(current?.fiveHour, patch.fiveHour),
    sevenDay: mergeRateLimitWindow(current?.sevenDay, patch.sevenDay),
  }
}

/**
 * Compares two rate-limit payloads by their visible rolling-window fields.
 *
 * @param left First rate-limit payload.
 * @param right Second rate-limit payload.
 * @returns Whether both payloads carry equivalent quota data.
 */
function sameRateLimits(
  left: TokenPayload['rateLimits'],
  right: TokenPayload['rateLimits'],
): boolean {
  return (
    sameRateLimitWindow(left?.fiveHour, right?.fiveHour) &&
    sameRateLimitWindow(left?.sevenDay, right?.sevenDay)
  )
}

/**
 * Compares two rolling quota windows.
 *
 * @param left First quota window.
 * @param right Second quota window.
 * @returns Whether usage and reset metadata are equal.
 */
function sameRateLimitWindow(
  left: TokenRateLimitWindow | undefined,
  right: TokenRateLimitWindow | undefined,
): boolean {
  return (
    left?.usedPercent === right?.usedPercent &&
    left?.resetsAt === right?.resetsAt &&
    left?.windowMinutes === right?.windowMinutes
  )
}

function isZeroOnlyRateLimits(rateLimits: TokenPayload['rateLimits']): boolean {
  const windows = [rateLimits?.fiveHour, rateLimits?.sevenDay].filter(Boolean)
  if (windows.length === 0) return false
  const hasUsagePercent = windows.some((window) => window?.usedPercent !== undefined)
  const hasResetMetadata = windows.some(
    (window) => window?.resetsAt !== undefined || window?.windowMinutes !== undefined,
  )
  return (
    hasUsagePercent &&
    !hasResetMetadata &&
    windows.every((window) => (window?.usedPercent ?? 0) === 0)
  )
}

/** Weekly plan windows are ≤7d; farther timestamps are almost always bad data. */
const MAX_REASONABLE_RESET_AHEAD_MS = 10 * 24 * 60 * 60_000
/** Maximum server reset-time jitter accepted as one canonical quota period. */
const RATE_LIMIT_RESET_TOLERANCE_MS = 60_000

function mergeRateLimitWindow(
  current: TokenRateLimitWindow | undefined,
  patch: TokenRateLimitWindow | undefined,
): TokenRateLimitWindow | undefined {
  if (!patch) return current
  const nowMs = Date.now()
  const sanePatch = sanitizeRateLimitWindow(patch, nowMs)
  if (!sanePatch) return current
  if (!current) return sanePatch

  const saneCurrent = sanitizeRateLimitWindow(current, nowMs) ?? current
  const curResetMs = normalizeResetAtMs(saneCurrent.resetsAt)
  const patchResetMs = normalizeResetAtMs(sanePatch.resetsAt)
  const resetOrder = compareRateLimitResetAt(patchResetMs, curResetMs)

  // Prefer a reasonable reset over an absurd far-future placeholder (e.g. 2000000000).
  const curAbsurd = isAbsurdResetMs(curResetMs, nowMs)
  const patchAbsurd = isAbsurdResetMs(patchResetMs, nowMs)
  if (curAbsurd && !patchAbsurd) {
    return {
      ...saneCurrent,
      ...sanePatch,
      usedPercent:
        sanePatch.usedPercent !== undefined ? sanePatch.usedPercent : saneCurrent.usedPercent,
    }
  }
  if (patchAbsurd && !curAbsurd) {
    // Keep current reset; still allow usage to rise on the real window.
    let usedPercent = saneCurrent.usedPercent
    if (sanePatch.usedPercent !== undefined) {
      usedPercent =
        usedPercent === undefined
          ? sanePatch.usedPercent
          : Math.max(usedPercent, sanePatch.usedPercent)
    }
    return {
      ...saneCurrent,
      ...(sanePatch.usedPercent !== undefined ? { usedPercent } : {}),
      ...(sanePatch.windowMinutes !== undefined ? { windowMinutes: sanePatch.windowMinutes } : {}),
    }
  }

  // A newer billing window fully replaces the previous one (usage may drop to ~0).
  if (resetOrder != null && resetOrder > 0) {
    return {
      ...saneCurrent,
      ...sanePatch,
    }
  }

  // An older window must never clobber a newer one (stale rollout / hook race).
  if (resetOrder != null && resetOrder < 0) {
    return saneCurrent
  }

  // Same window (or missing resetsAt): account usage only rises until official reset.
  // Expired same resetsAt: take *min* used% so soft-reset 0% is not clobbered by a
  // stale rollout still carrying pre-reset high % (last-write was wrong here).
  const windowExpired =
    (patchResetMs != null && patchResetMs <= nowMs) || (curResetMs != null && curResetMs <= nowMs)

  let usedPercent = saneCurrent.usedPercent
  if (sanePatch.usedPercent !== undefined) {
    if (saneCurrent.usedPercent === undefined) {
      usedPercent = sanePatch.usedPercent
    } else if (windowExpired) {
      usedPercent = Math.min(saneCurrent.usedPercent, sanePatch.usedPercent)
    } else {
      usedPercent = Math.max(saneCurrent.usedPercent, sanePatch.usedPercent)
    }
  }

  return {
    ...saneCurrent,
    ...(sanePatch.usedPercent !== undefined ? { usedPercent } : {}),
    ...(saneCurrent.resetsAt === undefined && sanePatch.resetsAt !== undefined
      ? { resetsAt: sanePatch.resetsAt }
      : {}),
    ...(sanePatch.windowMinutes !== undefined ? { windowMinutes: sanePatch.windowMinutes } : {}),
  }
}

function sanitizeRateLimitWindow(
  window: TokenRateLimitWindow,
  nowMs: number,
): TokenRateLimitWindow | undefined {
  const resetMs = normalizeResetAtMs(window.resetsAt)
  if (isAbsurdResetMs(resetMs, nowMs)) {
    // Keep usedPercent / windowMinutes; drop bogus resetsAt.
    if (window.usedPercent === undefined && window.windowMinutes === undefined) return undefined
    return {
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.windowMinutes !== undefined ? { windowMinutes: window.windowMinutes } : {}),
    }
  }
  return window
}

function isAbsurdResetMs(resetMs: number | undefined, nowMs: number): boolean {
  if (resetMs == null) return false
  return resetMs - nowMs > MAX_REASONABLE_RESET_AHEAD_MS
}

/** Normalize resets_at that may be seconds or milliseconds. */
function normalizeResetAtMs(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return undefined
  return resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
}

/**
 * Compares an incoming reset boundary with the retained canonical boundary.
 *
 * Same-period updates preserve the current reset timestamp, so every later
 * comparison stays anchored to the first accepted value instead of drifting.
 *
 * @param incoming Incoming reset in epoch milliseconds.
 * @param current Current reset in epoch milliseconds.
 * @returns Signed ordering, or `undefined` when either reset is unavailable.
 */
function compareRateLimitResetAt(
  incoming: number | undefined,
  current: number | undefined,
): number | undefined {
  if (incoming == null || current == null) return undefined
  const difference = incoming - current
  return Math.abs(difference) <= RATE_LIMIT_RESET_TOLERANCE_MS ? 0 : difference
}

/**
 * 为事件涉及的工具生成简短的人类可读描述。
 *
 * @param event 携带工具/命令上下文的事件。
 * @returns 中文活动描述；无可描述内容时为 `undefined`。
 */
function describeTool(event: AgentEvent): string | undefined {
  if (event.command) return `正在执行 ${event.command}`
  if (event.toolName) return `正在调用 ${event.toolName}`
  return undefined
}

/**
 * Keep the project root for display when later tool hooks report a subdirectory cwd.
 * If paths are unrelated, prefer the newer path.
 */
export function preferWorkspacePath(
  current: string | undefined,
  incoming: string | undefined,
): string | undefined {
  if (!incoming) return current
  if (!current) return incoming
  const currentKey = normalizeWorkspacePath(current)
  const incomingKey = normalizeWorkspacePath(incoming)
  if (!currentKey) return incoming
  if (!incomingKey) return current
  if (currentKey === incomingKey) return current
  // Incoming is under the known project root → keep the root.
  if (incomingKey.startsWith(`${currentKey}/`)) return current
  // Current was a subdir of the newer path → promote to the wider root.
  if (currentKey.startsWith(`${incomingKey}/`)) return incoming
  return incoming
}

/**
 * 穷尽性辅助函数：若新增事件类型而未补 `case`，则触发编译期错误；
 * 运行时到达此处则抛出异常。
 *
 * @param value 已被类型系统收窄为 `never` 的值。
 * @returns 永不返回。
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled event type: ${String(value)}`)
}

/**
 * {@link StatusHub} —— 把 reducer 与规则引擎串联起来的内存「大脑」，
 * 并向应用其余部分暴露一个小型事件 API。它为每个 agent 持有一份
 * 运行时状态，并刻意保持与框架无关（不依赖 Electron、HTTP 或数据库）。
 *
 * @module core/hub
 */
import { EventEmitter } from 'node:events'
import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
  type TokenPayload,
  type UiLocale,
  TurnState,
  workspaceKey,
} from '@codepulse/shared'
import { buildStatusSnapshot } from '../aggregate/index.js'
import { createInitialRuntimeState, reduce } from '../state-machine/index.js'
import {
  RuleEngine,
  STUCK_STRONG_MS,
  STUCK_VISIBLE_MS,
  type RuleEngineOptions,
} from '../rule-engine/index.js'

const WAITING_STALE_MS = 30 * 60_000
const IDLE_RETENTION_MS = 5 * 60_000
const DONE_RETENTION_MS = 5 * 60_000
const TIMEOUT_RETENTION_MS = 10 * 60_000
const ERROR_RETENTION_MS = 10 * 60_000
const CANCELLED_RETENTION_MS = 5 * 60_000
const USAGE_LIMITED_RETENTION_MS = 10 * 60_000

/**
 * {@link StatusHub} 发出的强类型事件。
 */
export interface StatusHubEvents {
  /** 每个已持久化的归一化事件（供存储/日志消费）。 */
  event: (event: AgentEvent) => void
  /** 聚合状态变化时发出。 */
  status: (snapshot: StatusSnapshot) => void
  /** 规则引擎决定触发通知时发出。 */
  notification: (notification: NotificationRequest) => void
}

/**
 * CodePulse 的内存「大脑」。
 *
 * 通过 {@link ingest} 投喂归一化事件；它应用状态机 reducer、运行
 * 规则引擎，并发出 `event` / `status` / `notification` 供 Electron
 * 主进程（或任意宿主）处理。由于不携带任何平台依赖，
 * 它也可以在测试中直接驱动。
 */
export class StatusHub extends EventEmitter {
  /** 当前运行时状态，每个 agent + workspace 一个槽位。 */
  private agents = new Map<string, AgentRuntimeState>()
  /** 让缺少 cwd 的后续事件仍能回到原 workspace。 */
  private sessionKeys = new Map<string, string>()
  /** 共享的、有状态的通知规则引擎。 */
  private rules: RuleEngine
  /** 无活动看门狗定时器句柄（运行中时存在）。 */
  private tickTimer?: NodeJS.Timeout

  /**
   * @param options 规则引擎调优（节流、初始静音状态）。
   */
  constructor(options: RuleEngineOptions = {}) {
    super()
    this.rules = new RuleEngine(options)
  }

  /**
   * 把一个归一化事件投喂给状态机与规则引擎。
   *
   * 总会发出 `event` 与 `status`（快照可能未变，但订阅方重渲染成本低），
   * 并对每条触发的规则发出 `notification`。
   *
   * @param event 待应用的归一化事件。
   */
  ingest(event: AgentEvent): void {
    this.applyEvent(event)
  }

  private applyEvent(event: AgentEvent, emitStatus = true): void {
    const key = this.keyForEvent(event)
    const current = this.agents.get(key) ?? createInitialRuntimeState(event.source)
    const result = reduce(current, event)
    this.agents.set(key, result.next)
    this.rememberEventKey(event, key)

    this.emit('event', event)
    if (emitStatus) this.emit('status', this.snapshot())

    for (const note of this.rules.onTransition(result, event.timestamp)) {
      this.emit('notification', note)
    }
  }

  /**
   * 把 agent 最近的终结结果标记为已确认，清除托盘「未读」标记。
   * 若没有未读内容则为空操作。
   *
   * @param agentType 要确认的 agent。
   */
  acknowledge(agentType: AgentType, workspacePath?: string): void {
    let changed = false
    for (const [key, current] of this.agents) {
      if (current.agentType !== agentType || !current.unread) continue
      if (workspacePath && workspaceKey(current.workspacePath) !== workspaceKey(workspacePath))
        continue
      this.agents.set(key, { ...current, unread: false })
      changed = true
    }
    if (changed) this.emit('status', this.snapshot())
  }

  /**
   * 全局开启或关闭通知声音。
   *
   * @param muted `true` 表示抑制声音。
   */
  setMuted(muted: boolean): void {
    this.rules.setMuted(muted)
  }

  /** 让后续系统通知使用桌面端当前选择的语言。 */
  setLocale(locale: UiLocale): void {
    this.rules.setLocale(locale)
  }

  /**
   * 构建当前的聚合状态快照。
   *
   * @param now 当前时间（epoch 毫秒，可注入便于测试）。
   * @returns 包含所有 agent 与总体指示的快照。
   */
  snapshot(now = Date.now()): StatusSnapshot {
    return buildStatusSnapshot([...this.agents.values()].sort(compareRuntimeState), now)
  }

  /**
   * 启动无活动（「疑似卡住」）看门狗。可重复调用；已有定时器会被替换。
   * 定时器已 `unref`，不会单独维持进程存活。
   *
   * @param intervalMs 卡住检查的运行间隔（毫秒）。
   */
  startWatchdog(intervalMs = 30_000): void {
    this.stopWatchdog()
    this.tickTimer = setInterval(() => this.tick(), intervalMs)
    this.tickTimer.unref?.()
  }

  /** 停止无活动看门狗（若在运行）。 */
  stopWatchdog(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  /**
   * 一次看门狗迭代：对每个 agent 运行卡住检查，发出由此产生的通知
   * （如有变化再发一次 `status` 更新）。
   *
   * @param now 当前时间（epoch 毫秒，可注入便于测试）。
   */
  private tick(now = Date.now()): void {
    let changed = false
    for (const [key, agent] of [...this.agents.entries()]) {
      const timeoutEvent = this.timeoutEventFor(agent, now)
      const current = timeoutEvent ? this.applyTimeoutEvent(timeoutEvent, key) : agent

      for (const note of this.rules.onTick(current, now)) {
        this.emit('notification', note)
        changed = true
      }
      if (timeoutEvent) {
        changed = true
      }
    }
    if (this.pruneExpiredAgents(now)) {
      changed = true
    }
    if (changed) this.emit('status', this.snapshot(now))
  }

  private pruneExpiredAgents(now: number): boolean {
    let changed = false
    for (const [key, agent] of [...this.agents.entries()]) {
      if (!isExpiredAgent(agent, now)) continue
      if (hasRetainedQuota(agent.token)) {
        if (!agent.taskHidden || agent.unread) {
          this.agents.set(key, { ...agent, taskHidden: true, unread: false })
          changed = true
        }
        continue
      }
      this.agents.delete(key)
      if (agent.externalSessionId) {
        this.sessionKeys.delete(sessionKey(agent.agentType, agent.externalSessionId))
      }
      changed = true
    }
    return changed
  }

  private applyTimeoutEvent(event: AgentEvent, key: string): AgentRuntimeState {
    this.applyEvent(event, false)
    return this.agents.get(key) ?? createInitialRuntimeState(event.source)
  }

  private timeoutEventFor(agent: AgentRuntimeState, now: number): AgentEvent | undefined {
    if (agent.lastEventAt === 0 || !canTimeoutState(agent.state)) return undefined
    const threshold = timeoutThreshold(agent.state)
    if (now - agent.lastEventAt < threshold) return undefined

    const scope = agent.externalSessionId ?? workspaceKey(agent.workspacePath)
    const turn = agent.externalTurnId ?? String(agent.turnStartedAt ?? agent.lastEventAt)
    return {
      id: `timeout:${agent.agentType}:${scope}:${turn}:${now}`,
      source: agent.agentType,
      eventType: 'turn_timeout',
      externalSessionId: agent.externalSessionId,
      externalTurnId: agent.externalTurnId,
      workspacePath: agent.workspacePath,
      cwd: agent.workspacePath,
      model: agent.model,
      message: '疑似卡住',
      timestamp: now,
    }
  }

  // 强类型事件辅助方法 --------------------------------------------------------

  /**
   * 限定到 {@link StatusHubEvents} 的类型安全 {@link EventEmitter.on}。
   *
   * @param event 事件名。
   * @param listener 该事件的强类型监听器。
   * @returns 本 hub，便于链式调用。
   */
  override on<E extends keyof StatusHubEvents>(event: E, listener: StatusHubEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  /**
   * 限定到 {@link StatusHubEvents} 的类型安全 {@link EventEmitter.emit}。
   *
   * @param event 事件名。
   * @param args 该事件的强类型参数。
   * @returns 若事件有监听器则为 `true`。
   */
  override emit<E extends keyof StatusHubEvents>(
    event: E,
    ...args: Parameters<StatusHubEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }

  private keyForEvent(event: AgentEvent): string {
    // Prefer session identity so tool hooks that report a subdirectory cwd
    // (common with Claude Code) stay on the same project card.
    if (event.externalSessionId) {
      const known = this.sessionKeys.get(sessionKey(event.source, event.externalSessionId))
      if (known) return known
      return sessionRuntimeKey(event.source, event.externalSessionId)
    }
    const workspace = event.workspacePath ?? event.cwd
    if (workspace) return runtimeKey(event.source, workspace)
    return runtimeKey(event.source, '')
  }

  private rememberEventKey(event: AgentEvent, key: string): void {
    if (event.externalSessionId) {
      this.sessionKeys.set(sessionKey(event.source, event.externalSessionId), key)
    }
  }
}

function runtimeKey(agentType: AgentType, workspacePath: string): string {
  return `${agentType}\0${workspaceKey(workspacePath)}`
}

function sessionRuntimeKey(agentType: AgentType, externalSessionId: string): string {
  return `${agentType}\0session:${externalSessionId}`
}

function canTimeoutState(state: TurnState): boolean {
  return (
    state === TurnState.PROMPT_SUBMITTED ||
    state === TurnState.THINKING ||
    state === TurnState.TOOL_RUNNING ||
    state === TurnState.WAITING_PERMISSION ||
    state === TurnState.WAITING_USER_INPUT
  )
}

function timeoutThreshold(state: TurnState): number {
  if (state === TurnState.TOOL_RUNNING) return STUCK_STRONG_MS
  if (state === TurnState.WAITING_PERMISSION || state === TurnState.WAITING_USER_INPUT) {
    return WAITING_STALE_MS
  }
  return STUCK_VISIBLE_MS
}

function isExpiredAgent(agent: AgentRuntimeState, now: number): boolean {
  const terminalAt = agent.terminalAt ?? agent.lastEventAt
  if (terminalAt <= 0) return false
  const retentionMs = stateRetentionMs(agent.state)
  return retentionMs != null && now - terminalAt >= retentionMs
}

function hasRetainedQuota(token: TokenPayload | undefined): boolean {
  return Boolean(
    token?.rateLimits?.fiveHour ||
    token?.rateLimits?.sevenDay ||
    Object.values(token?.quotaBuckets ?? {}).some(
      (bucket) => bucket.rateLimits?.fiveHour || bucket.rateLimits?.sevenDay,
    ),
  )
}

function stateRetentionMs(state: TurnState): number | undefined {
  if (state === TurnState.IDLE) return IDLE_RETENTION_MS
  if (state === TurnState.DONE) return DONE_RETENTION_MS
  if (state === TurnState.TIMEOUT) return TIMEOUT_RETENTION_MS
  if (state === TurnState.ERROR) return ERROR_RETENTION_MS
  if (state === TurnState.CANCELLED) return CANCELLED_RETENTION_MS
  if (state === TurnState.USAGE_LIMITED) return USAGE_LIMITED_RETENTION_MS
  return undefined
}

function sessionKey(agentType: AgentType, sessionId: string): string {
  return `${agentType}\0${sessionId}`
}

function compareRuntimeState(a: AgentRuntimeState, b: AgentRuntimeState): number {
  return (
    b.lastEventAt - a.lastEventAt ||
    a.agentType.localeCompare(b.agentType) ||
    workspaceKey(a.workspacePath).localeCompare(workspaceKey(b.workspacePath)) ||
    (a.externalSessionId ?? '').localeCompare(b.externalSessionId ?? '')
  )
}

/**
 * The notification rule engine. It turns state transitions and inactivity ticks
 * into {@link NotificationRequest}s, and enforces the anti-disturbance rules
 * from requirements §5.3 / §5.7 (dedup, per-key throttling, mute).
 *
 * @module core/rule-engine
 */
import {
  type AgentRuntimeState,
  type NotificationRequest,
  type NotificationLevel,
  TurnState,
} from '@codepulse/shared'
import type { TransitionResult } from '../state-machine/index.js'

/** Inactivity threshold for the first soft "long time no response" nudge. */
export const STUCK_SOFT_MS = 2 * 60_000
/** Inactivity threshold at which the UI shows "suspected stuck". */
export const STUCK_VISIBLE_MS = 5 * 60_000
/** Inactivity threshold for the strong "suspected stuck" alert. */
export const STUCK_STRONG_MS = 10 * 60_000

/** Context usage (%) at which a soft warning fires. */
export const CONTEXT_SOFT_PERCENT = 80
/** Context usage (%) at which a strong warning fires. */
export const CONTEXT_STRONG_PERCENT = 95

/**
 * Tuning options for the {@link RuleEngine}.
 */
export interface RuleEngineOptions {
  /** Global mute — when true, notifications still emit but request no sound. */
  muted?: boolean
  /** Minimum gap between any two notifications for one agent (ms). */
  sessionThrottleMs?: number
  /** Minimum gap between permission reminders (ms). */
  permissionThrottleMs?: number
}

/** Built-in throttle defaults (requirements §5.7). */
const DEFAULTS = {
  sessionThrottleMs: 30_000,
  permissionThrottleMs: 60_000,
}

/**
 * Decides which notifications to fire and enforces the anti-disturbance rules.
 *
 * The engine is stateful: it remembers per-key fire times and the highest
 * context/stuck level already announced, so it must be kept as a single
 * long-lived instance per process (the {@link StatusHub} owns one).
 */
export class RuleEngine {
  /** Last fire time per dedupe key, for throttling. */
  private lastFiredAt = new Map<string, number>()
  /** Highest context-usage level already announced, per agent. */
  private contextLevelFired = new Map<string, NotificationLevel>()
  /** Highest stuck level already announced, per agent. */
  private stuckLevelFired = new Map<string, 'soft' | 'visible' | 'strong'>()

  /**
   * @param options Throttling and mute configuration; sensible defaults apply.
   */
  constructor(private options: RuleEngineOptions = {}) {}

  /**
   * Enables or disables sound on subsequently-emitted notifications.
   *
   * @param muted `true` to suppress sound (notifications still display).
   */
  setMuted(muted: boolean): void {
    this.options.muted = muted
  }

  /**
   * Computes the notifications triggered by a single state transition.
   *
   * Lifecycle changes (done / permission / input / error) each map to a
   * notification; context-threshold warnings are also checked. All results are
   * already deduped/throttled.
   *
   * @param result The transition produced by the state machine.
   * @param now Current time in epoch millis (injectable for testing).
   * @returns Zero or more notifications to display.
   */
  onTransition(result: TransitionResult, now = Date.now()): NotificationRequest[] {
    const { next, previousState } = result
    const agent = next.agentType
    const out: NotificationRequest[] = []

    if (next.state === previousState) {
      // Only context thresholds can fire without a lifecycle change.
      this.collectContextNotifications(next, out, now)
      return out
    }

    switch (next.state) {
      case TurnState.DONE:
        this.push(out, now, {
          level: 'normal',
          title: `${agentLabel(agent)} 完成一轮任务`,
          body: next.lastAssistantMessage ?? '当前一轮任务已完成',
          dedupeKey: `done:${agent}:${next.externalTurnId ?? next.turnStartedAt ?? now}`,
        })
        break
      case TurnState.WAITING_PERMISSION:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 需要授权`,
          body: next.activity ?? '请求执行操作，等待授权',
          dedupeKey: `perm:${agent}:${next.externalTurnId ?? ''}`,
          throttleMs: this.options.permissionThrottleMs ?? DEFAULTS.permissionThrottleMs,
        })
        break
      case TurnState.WAITING_USER_INPUT:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 等待输入`,
          body: next.activity ?? '等待用户继续输入',
          dedupeKey: `input:${agent}:${next.externalTurnId ?? ''}`,
        })
        break
      case TurnState.ERROR:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 执行出错`,
          body: next.activity ?? '任务执行出错',
          dedupeKey: `error:${agent}:${next.externalTurnId ?? now}`,
        })
        break
    }

    this.collectContextNotifications(next, out, now)
    return out
  }

  /**
   * Inactivity ("疑似卡住") check, intended to run on a timer for every active
   * agent. Escalates through soft → visible → strong as time without events
   * grows, firing each level at most once until the agent moves again.
   *
   * @param agent The agent's current runtime state.
   * @param now Current time in epoch millis (injectable for testing).
   * @returns Zero or one stuck notification.
   */
  onTick(agent: AgentRuntimeState, now = Date.now()): NotificationRequest[] {
    const out: NotificationRequest[] = []
    const inactiveFor = now - agent.lastEventAt
    const isActive =
      agent.state !== TurnState.IDLE &&
      agent.state !== TurnState.DONE &&
      agent.state !== TurnState.ERROR
    if (!isActive || agent.lastEventAt === 0) {
      this.stuckLevelFired.delete(agent.agentType)
      return out
    }

    const fired = this.stuckLevelFired.get(agent.agentType)
    if (inactiveFor >= STUCK_STRONG_MS && fired !== 'strong') {
      this.stuckLevelFired.set(agent.agentType, 'strong')
      this.push(out, now, {
        level: 'strong',
        title: `${agentLabel(agent.agentType)} 疑似卡住`,
        body: '超过 10 分钟没有新事件',
        dedupeKey: `stuck:${agent.agentType}:strong`,
      })
    } else if (inactiveFor >= STUCK_VISIBLE_MS && (fired === undefined || fired === 'soft')) {
      this.stuckLevelFired.set(agent.agentType, 'visible')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 可能卡住`,
        body: '超过 5 分钟没有新事件',
        dedupeKey: `stuck:${agent.agentType}:visible`,
      })
    } else if (inactiveFor >= STUCK_SOFT_MS && fired === undefined) {
      this.stuckLevelFired.set(agent.agentType, 'soft')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 长时间无响应`,
        body: '超过 2 分钟没有新事件',
        dedupeKey: `stuck:${agent.agentType}:soft`,
      })
    }
    return out
  }

  /**
   * Appends context-usage warnings for an agent if its context crossed the soft
   * or strong threshold since the last announcement. Resets once usage drops
   * back below the soft threshold (e.g. after a compaction).
   *
   * @param agent The agent's current runtime state.
   * @param out The output array to append to.
   * @param now Current time in epoch millis.
   */
  private collectContextNotifications(
    agent: AgentRuntimeState,
    out: NotificationRequest[],
    now: number,
  ): void {
    const pct = agent.token?.contextUsedPercent
    if (pct == null) return
    const already = this.contextLevelFired.get(agent.agentType)
    if (pct >= CONTEXT_STRONG_PERCENT && already !== 'strong') {
      this.contextLevelFired.set(agent.agentType, 'strong')
      this.push(out, now, {
        level: 'strong',
        title: `${agentLabel(agent.agentType)} 上下文即将耗尽`,
        body: `Context 已使用 ${Math.round(pct)}%`,
        dedupeKey: `ctx:${agent.agentType}:strong`,
      })
    } else if (pct >= CONTEXT_SOFT_PERCENT && already === undefined) {
      this.contextLevelFired.set(agent.agentType, 'soft')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 上下文偏高`,
        body: `Context 已使用 ${Math.round(pct)}%`,
        dedupeKey: `ctx:${agent.agentType}:soft`,
      })
    } else if (pct < CONTEXT_SOFT_PERCENT) {
      this.contextLevelFired.delete(agent.agentType)
    }
  }

  /**
   * Emits a notification unless an identical `dedupeKey` fired within its
   * throttle window. Records the fire time and resolves the `sound` flag from
   * the level and mute state.
   *
   * @param out The output array to append to.
   * @param now Current time in epoch millis.
   * @param spec The notification specification (level, text, key, throttle).
   */
  private push(
    out: NotificationRequest[],
    now: number,
    spec: {
      level: NotificationLevel
      title: string
      body: string
      dedupeKey: string
      throttleMs?: number
    },
  ): void {
    const throttle = spec.throttleMs ?? this.options.sessionThrottleMs ?? DEFAULTS.sessionThrottleMs
    const last = this.lastFiredAt.get(spec.dedupeKey)
    if (last != null && now - last < throttle) return
    this.lastFiredAt.set(spec.dedupeKey, now)
    out.push({
      level: spec.level,
      title: spec.title,
      body: spec.body,
      dedupeKey: spec.dedupeKey,
      sound: !this.options.muted && spec.level !== 'soft',
      createdAt: now,
    })
  }
}

/**
 * Maps an agent type to its display label.
 *
 * @param agent The agent type string.
 * @returns `"Codex"` or `"Claude Code"`.
 */
function agentLabel(agent: string): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}

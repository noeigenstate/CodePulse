/**
 * 通知规则引擎。把状态迁移与无活动定时检查转换为
 * {@link NotificationRequest}，并执行需求 §5.3 / §5.7 中的防打扰规则
 * （去重、按键节流、静音）。
 *
 * @module core/rule-engine
 */
import {
  type AgentRuntimeState,
  type NotificationRequest,
  type NotificationLevel,
  TurnState,
  formatTokenQuotaNotice,
  isActiveState,
} from '@codepulse/shared'
import type { TransitionResult } from '../state-machine/index.js'

/** 触发首次「长时间无响应」软提醒的无活动阈值。 */
export const STUCK_SOFT_MS = 2 * 60_000
/** UI 显示「可能卡住」的无活动阈值。 */
export const STUCK_VISIBLE_MS = 5 * 60_000
/** 触发「疑似卡住」强提醒的无活动阈值。 */
export const STUCK_STRONG_MS = 10 * 60_000

/** 触发软警告的上下文使用率（%）。 */
export const CONTEXT_SOFT_PERCENT = 80
/** 触发强警告的上下文使用率（%）。 */
export const CONTEXT_STRONG_PERCENT = 95

/**
 * {@link RuleEngine} 的调优选项。
 */
export interface RuleEngineOptions {
  /** 全局静音 —— 为 true 时通知仍会发出，但不请求声音。 */
  muted?: boolean
  /** 同一 agent 任意两条通知之间的最小间隔（毫秒）。 */
  sessionThrottleMs?: number
  /** 授权提醒之间的最小间隔（毫秒）。 */
  permissionThrottleMs?: number
}

/** 内置节流默认值（需求 §5.7）。 */
const DEFAULTS = {
  sessionThrottleMs: 30_000,
  permissionThrottleMs: 60_000,
}

const FIRED_KEY_RETENTION_MS = 10 * 60_000

/**
 * 决定发出哪些通知并执行防打扰规则。
 *
 * 引擎是有状态的：它记录每个去重键的触发时间，以及已经播报过的
 * 最高上下文/卡住级别，因此每个进程必须保持单个长生命周期实例
 * （由 {@link StatusHub} 持有）。
 */
export class RuleEngine {
  /** 每个去重键的最近触发时间，用于节流。 */
  private lastFiredAt = new Map<string, number>()
  /** 每个 agent 已播报过的最高上下文使用级别。 */
  private contextLevelFired = new Map<string, NotificationLevel>()
  /** 每个 agent 已播报过的最高卡住级别。 */
  private stuckLevelFired = new Map<string, 'soft' | 'visible' | 'strong'>()

  /**
   * @param options 节流与静音配置；有合理的默认值。
   */
  constructor(private options: RuleEngineOptions = {}) {}

  /**
   * 启用或关闭后续通知的声音。
   *
   * @param muted `true` 表示抑制声音（通知仍会展示）。
   */
  setMuted(muted: boolean): void {
    this.options.muted = muted
  }

  /**
   * 计算单次状态迁移触发的通知。
   *
   * 生命周期变化（完成 / 授权 / 输入 / 错误）各映射一条通知；
   * 同时检查上下文阈值警告。所有结果均已去重/节流。
   *
   * @param result 状态机产生的迁移结果。
   * @param now 当前时间（epoch 毫秒，可注入便于测试）。
   * @returns 零条或多条待展示通知。
   */
  onTransition(result: TransitionResult, now = Date.now()): NotificationRequest[] {
    const { next, previous, previousState } = result
    const agent = next.agentType
    const scope = agentScope(next)
    const out: NotificationRequest[] = []

    if (next.state === previousState) {
      // 没有生命周期变化时，只有上下文阈值可能触发。
      this.collectContextNotifications(next, out, now)
      return out
    }

    this.stuckLevelFired.delete(scope)

    switch (next.state) {
      case TurnState.DONE:
        this.push(out, now, {
          level: 'normal',
          title: `${agentLabel(agent)} 完成一轮任务`,
          body: next.lastAssistantMessage ?? '当前一轮任务已完成',
          dedupeKey: `done:${scope}:${
            next.externalTurnId ?? previous.externalTurnId ?? previous.turnStartedAt ?? now
          }`,
        })
        break
      case TurnState.WAITING_PERMISSION:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 需要授权`,
          body: next.activity ?? '请求执行操作，等待授权',
          dedupeKey: `perm:${scope}:${next.externalTurnId ?? ''}`,
          throttleMs: this.options.permissionThrottleMs ?? DEFAULTS.permissionThrottleMs,
        })
        break
      case TurnState.WAITING_USER_INPUT:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 等待输入`,
          body: next.activity ?? '等待用户继续输入',
          dedupeKey: `input:${scope}:${next.externalTurnId ?? ''}`,
        })
        break
      case TurnState.CANCELLED:
        this.push(out, now, {
          level: 'normal',
          title: `${agentLabel(agent)} 任务已取消`,
          body: next.activity ?? '当前一轮任务已取消',
          dedupeKey: `cancelled:${scope}:${
            next.externalTurnId ?? previous.externalTurnId ?? previous.turnStartedAt ?? now
          }`,
        })
        break
      case TurnState.ERROR:
        this.push(out, now, {
          level: 'strong',
          title: `${agentLabel(agent)} 执行出错`,
          body: next.activity ?? '任务执行出错',
          dedupeKey: `error:${scope}:${next.externalTurnId ?? now}`,
        })
        break
    }

    this.collectContextNotifications(next, out, now)
    return out
  }

  /**
   * 无活动（「疑似卡住」）检查，应由定时器对每个活动 agent 周期执行。
   * 随无事件时间增长按 soft → visible → strong 逐级升级，
   * 每级最多触发一次，直到该 agent 再次活动。
   *
   * @param agent agent 的当前运行时状态。
   * @param now 当前时间（epoch 毫秒，可注入便于测试）。
   * @returns 零条或一条卡住通知。
   */
  onTick(agent: AgentRuntimeState, now = Date.now()): NotificationRequest[] {
    const out: NotificationRequest[] = []
    const inactiveFor = now - agent.lastEventAt
    const canCheckStuck = isActiveState(agent.state) || agent.state === TurnState.TIMEOUT
    const scope = agentScope(agent)
    if (!canCheckStuck || agent.lastEventAt === 0) {
      this.stuckLevelFired.delete(scope)
      return out
    }

    const fired = this.stuckLevelFired.get(scope)
    if (inactiveFor >= STUCK_STRONG_MS && fired !== 'strong') {
      this.stuckLevelFired.set(scope, 'strong')
      this.push(out, now, {
        level: 'strong',
        title: `${agentLabel(agent.agentType)} 疑似卡住`,
        body: '超过 10 分钟没有新事件',
        dedupeKey: `stuck:${scope}:strong`,
      })
    } else if (inactiveFor >= STUCK_VISIBLE_MS && (fired === undefined || fired === 'soft')) {
      this.stuckLevelFired.set(scope, 'visible')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 可能卡住`,
        body: '超过 5 分钟没有新事件',
        dedupeKey: `stuck:${scope}:visible`,
      })
    } else if (inactiveFor >= STUCK_SOFT_MS && fired === undefined) {
      this.stuckLevelFired.set(scope, 'soft')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 长时间无响应`,
        body: '超过 2 分钟没有新事件',
        dedupeKey: `stuck:${scope}:soft`,
      })
    }
    return out
  }

  /**
   * 当 agent 的上下文使用率自上次播报后越过软/强阈值时，
   * 追加上下文用量警告。用量回落到软阈值以下（如压缩后）时重置。
   *
   * @param agent agent 的当前运行时状态。
   * @param out 追加结果的输出数组。
   * @param now 当前时间（epoch 毫秒）。
   */
  private collectContextNotifications(
    agent: AgentRuntimeState,
    out: NotificationRequest[],
    now: number,
  ): void {
    const token = agent.token
    const pct = token?.contextUsedPercent
    if (pct == null || !token) return
    const scope = agentScope(agent)
    const already = this.contextLevelFired.get(scope)
    if (pct >= CONTEXT_STRONG_PERCENT && already !== 'strong') {
      this.contextLevelFired.set(scope, 'strong')
      this.push(out, now, {
        level: 'strong',
        title: `${agentLabel(agent.agentType)} 上下文即将耗尽`,
        body: formatTokenQuotaNotice(agent.agentType, token),
        dedupeKey: `ctx:${scope}:strong`,
      })
    } else if (pct >= CONTEXT_SOFT_PERCENT && already === undefined) {
      this.contextLevelFired.set(scope, 'soft')
      this.push(out, now, {
        level: 'soft',
        title: `${agentLabel(agent.agentType)} 上下文偏高`,
        body: formatTokenQuotaNotice(agent.agentType, token),
        dedupeKey: `ctx:${scope}:soft`,
      })
    } else if (pct < CONTEXT_SOFT_PERCENT) {
      this.contextLevelFired.delete(scope)
    }
  }

  /**
   * 发出一条通知，除非相同 `dedupeKey` 在其节流窗口内已触发过。
   * 记录触发时间，并根据级别与静音状态解析 `sound` 标志。
   *
   * @param out 追加结果的输出数组。
   * @param now 当前时间（epoch 毫秒）。
   * @param spec 通知规格（级别、文案、键、节流）。
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
    this.pruneFiredKeys(now)
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

  private pruneFiredKeys(now: number): void {
    for (const [key, firedAt] of this.lastFiredAt) {
      if (now - firedAt > FIRED_KEY_RETENTION_MS) this.lastFiredAt.delete(key)
    }
  }
}

/**
 * 把 agent 类型映射为显示标签。
 *
 * @param agent agent 类型字符串。
 * @returns `"Codex"` 或 `"Claude Code"`。
 */
function agentLabel(agent: string): string {
  return agent === 'codex' ? 'Codex' : 'Claude Code'
}

function agentScope(agent: AgentRuntimeState): string {
  return `${agent.agentType}:${(agent.workspacePath ?? '').replace(/[\\/]+$/, '').toLowerCase()}`
}

/**
 * 归一化后的内部事件词汇表。hook 脚本 POST 原始的 agent 专有载荷；
 * 适配器把它们转换为此处定义的 {@link AgentEvent} 形态，
 * 这是系统其余部分理解的唯一事件类型（需求 §7.6）。
 *
 * @module shared/types/event
 */
import type { AgentType } from './agent.js'
import type { TurnTiming } from './timing.js'
import type { TokenPayload } from './token.js'

/**
 * CodePulse 响应的封闭事件种类集合。
 *
 * 适配器把每个 agent 的原生 hook 事件映射到其中之一。
 */
export type AgentEventType =
  | 'session_start'
  | 'prompt_submit'
  | 'tool_start'
  | 'tool_end'
  | 'permission_request'
  | 'user_input_required'
  | 'turn_stop'
  | 'turn_error'
  | 'turn_cancelled'
  | 'turn_timeout'
  | 'usage_limited'
  | 'token_snapshot'
  | 'session_end'

/**
 * 所有适配器统一归一化到的内部事件形态。
 *
 * 多数字段是可选的，因为不同事件种类携带不同上下文；
 * 状态机按 `eventType` 读取相关字段。
 */
export interface AgentEvent {
  /** 唯一事件 id（缺失时在归一化阶段分配）。 */
  id: string
  /** 发出事件的 agent。 */
  source: AgentType
  /** 事件种类。 */
  eventType: AgentEventType

  /** agent 分配的会话 id（如有）。 */
  externalSessionId?: string
  /** agent 分配的轮次 id（如有）。 */
  externalTurnId?: string
  /** agent 上报的工作区路径。 */
  workspacePath?: string
  /** agent 上报的当前工作目录。 */
  cwd?: string
  /** 使用的模型（如有上报）。 */
  model?: string
  /** 模型配置的思考深度，不等同于实际产生的推理 token 数。 */
  reasoningEffort?: string
  /**
   * 原生 CLI 最近一次记录思考深度配置的时间（epoch 毫秒）。它可以来自独立
   * 的全局设置，不要求与 `modelObservedAt` 属于同一份模型快照。
   */
  reasoningEffortObservedAt?: number
  /**
   * CLI rollout 记录这组模型配置的时间（epoch 毫秒）。存在时，`model` 与
   * `reasoningEffort` 必须作为同一份配置快照一起处理。
   */
  modelObservedAt?: number
  /** `tool_start`/`tool_end`/`permission_request` 的工具名。 */
  toolName?: string
  /** shell 类工具调用的命令行。 */
  command?: string
  /** 自由文本消息（通知文本、最后一条助手消息等）。 */
  message?: string

  /** `token_snapshot` 事件内联的 token/上下文用量。 */
  token?: TokenPayload
  /**
   * CLI 本地会话文件中读出的当前或最近一轮耗时快照。它与事件接收时间分离，
   * 以便后台间歇同步不会把扫描时刻误认为任务开始时间。
   */
  turnTiming?: TurnTiming
  /** token 快照来源的本地文件路径，用于服务端做绑定会话的轻量刷新。 */
  tokenSourcePath?: string

  /** Internal metadata produced by CodePulse itself rather than CLI hooks. */
  internal?: {
    /** Token-only quota refreshes must not update project recency or runtime model. */
    quotaRefresh?: boolean
    /**
     * Disk session scan on app open / interval. Updates project lastEventAt when
     * activity changes so background CLI tasks appear without waiting for a hook.
     * Combined with quotaRefresh when only rate limits changed (no recency bump).
     */
    sessionSync?: boolean
    /**
     * The local CLI source changed since the previous synchronization scan.
     * This is stronger than merely seeing a persisted active record again and
     * may safely recover a card that the watchdog marked as timed out.
     */
    activityRefresh?: boolean
  }

  /** 原始 Hook 载荷，仅供进程内归一化/调试，禁止持久化到 SQLite。 */
  raw?: unknown
  /** 事件发生时间（epoch 毫秒，缺失时在归一化阶段分配）。 */
  timestamp: number
}

/**
 * `POST /api/events` 接受的形态：`id` 与 `timestamp` 可省略的
 * {@link AgentEvent}，由 {@link normalizeEvent | 归一化器} 补全。
 */
export type AgentEventInput = Omit<AgentEvent, 'id' | 'timestamp'> & {
  id?: string
  timestamp?: number
}

/**
 * 归一化后的内部事件词汇表。hook 脚本 POST 原始的 agent 专有载荷；
 * 适配器把它们转换为此处定义的 {@link AgentEvent} 形态，
 * 这是系统其余部分理解的唯一事件类型（需求 §7.6）。
 *
 * @module shared/types/event
 */
import type { AgentType } from './agent.js'
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
  /** `tool_start`/`tool_end`/`permission_request` 的工具名。 */
  toolName?: string
  /** shell 类工具调用的命令行。 */
  command?: string
  /** 自由文本消息（通知文本、最后一条助手消息等）。 */
  message?: string

  /** `token_snapshot` 事件内联的 token/上下文用量。 */
  token?: TokenPayload
  /** token 快照来源的本地文件路径，用于服务端做绑定会话的轻量刷新。 */
  tokenSourcePath?: string

  /** Internal metadata produced by CodePulse itself rather than CLI hooks. */
  internal?: {
    /** Token-only quota refreshes must not update project recency or runtime model. */
    quotaRefresh?: boolean
    /**
     * Disk session scan on app open / interval. Still updates project lastEventAt
     * so background CLI tasks appear within seconds, without waiting for a hook.
     */
    sessionSync?: boolean
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

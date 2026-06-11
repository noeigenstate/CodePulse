/**
 * Token / 上下文用量类型。CodePulse 记录每个轮次消耗了多少上下文窗口
 * 与预算，并标注测量值的可信程度（需求 §5.4）。
 *
 * @module shared/types/token
 */
import type { AgentType } from './agent.js'

/**
 * token/上下文测量值的可信程度。
 *
 * - `exact` —— 来自稳定的结构化来源（如 Claude 的 status line）。
 * - `estimated` —— 由 transcript 或其他启发式方法推断。
 * - `unknown` —— 当前不可用。
 */
export type TokenAccuracy = 'exact' | 'estimated' | 'unknown'

/**
 * token / 上下文用量的时间点快照，持久化到数据库，
 * 以便绘制会话生命周期内的用量曲线。
 */
export interface TokenSnapshot {
  /** 稳定的内部标识符。 */
  id: string
  /** 所属会话。 */
  sessionId: string
  /** 所属轮次（如已知）。 */
  turnId?: string
  /** 产生该测量值的 agent。 */
  agentType: AgentType
  /** 提示词/输入 token 数（如有上报）。 */
  inputTokens?: number
  /** 补全/输出 token 数（如有上报）。 */
  outputTokens?: number
  /** 总 token 数（如有上报）。 */
  totalTokens?: number
  /** 上下文窗口已用百分比（0–100，如有上报）。 */
  contextUsedPercent?: number
  /** 花费（美元，如有上报）。 */
  costUsd?: number
  /** 上述数字的可信度。 */
  accuracy: TokenAccuracy
  /** 快照采集时间（epoch 毫秒）。 */
  capturedAt: number
}

/**
 * 内联在 {@link AgentEvent} 上、并展示在 {@link AgentRuntimeState} 上的
 * 紧凑 token 载荷。是去掉存储标识符后的精简版 {@link TokenSnapshot}。
 */
export interface TokenPayload {
  /** 提示词/输入 token 数。 */
  input?: number
  /** 补全/输出 token 数。 */
  output?: number
  /** 总 token 数。 */
  total?: number
  /** 上下文窗口已用百分比（0–100）。 */
  contextUsedPercent?: number
  /** 花费（美元）。 */
  costUsd?: number
  /** 数字的可信度。 */
  accuracy: TokenAccuracy
}

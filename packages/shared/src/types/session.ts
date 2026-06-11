/**
 * 会话（session）与轮次（turn）类型。一个会话是一次 agent 对话；
 * 一个轮次是其中一次「用户提示 → AI 回复」的循环（需求 §7.3–§7.4）。
 *
 * @module shared/types/session
 */
import type { AgentType } from './agent.js'
import type { TurnState } from './state.js'

/**
 * 粗粒度的会话生命周期状态，持久化在会话行上。
 *
 * 刻意比 {@link TurnState} 简单：它概括整个对话，
 * 而不是单个轮次的细粒度活动。
 */
export type SessionState = 'idle' | 'running' | 'waiting' | 'done' | 'error'

/**
 * 一次 AI agent 对话，可能跨越多个轮次。
 *
 * 对外以 `externalSessionId`（agent 自己分配的 id）标识，
 * 对内以 `id` 标识。
 */
export interface Session {
  /** 稳定的内部标识符。 */
  id: string
  /** 会话所属的 agent。 */
  agentType: AgentType
  /** agent 自己分配的会话 id。 */
  externalSessionId: string
  /** 会话所在的工作区。 */
  workspaceId: string
  /** 使用的模型（如已知）。 */
  model?: string
  /** 粗粒度生命周期状态。 */
  state: SessionState
  /** 会话开始时间（epoch 毫秒）。 */
  startedAt: number
  /** 会话结束时间（epoch 毫秒，结束后存在）。 */
  endedAt?: number
}

/**
 * 一次「用户提示 → AI 回复」的循环（需求 §7.4）。
 *
 * 轮次是 CodePulse 发送通知的基本单位：轮次完成、等待授权、
 * 等待输入均各自映射为一条通知。
 */
export interface Turn {
  /** 稳定的内部标识符。 */
  id: string
  /** 所属会话。 */
  sessionId: string
  /** agent 分配的轮次 id（如有）。 */
  externalTurnId?: string
  /** 当前的细粒度状态。 */
  state: TurnState
  /** 用户提示词的隐私受限预览。 */
  promptPreview?: string
  /** 轮次开始时间（epoch 毫秒）。 */
  startedAt: number
  /** 轮次结束时间（epoch 毫秒，结束后存在）。 */
  endedAt?: number
  /** 轮次内观察到的工具调用次数。 */
  toolCallCount: number
  /** 轮次是否曾因等待授权而暂停。 */
  needPermission: boolean
  /** 轮次是否曾因等待用户输入而暂停。 */
  needUserInput: boolean
  /** AI 最终消息的摘要（如有捕获）。 */
  lastAssistantMessage?: string
}

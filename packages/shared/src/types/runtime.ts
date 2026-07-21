/**
 * 实时运行时视图类型：Dashboard 渲染的内存态、聚合后的托盘指示、
 * 极简硬件投影，以及服务器→客户端的推送/通知载荷。
 *
 * @module shared/types/runtime
 */
import type { AgentType } from './agent.js'
import type { TurnState } from './state.js'
import type { TurnTiming } from './timing.js'
import type { TokenPayload } from './token.js'

/**
 * 单个 agent 当前活动的实时内存视图。
 *
 * 这是 Dashboard 渲染、`/api/status` 按 agent 返回的内容。
 * 与持久化的 {@link Session}/{@link Turn} 行不同，它在每次状态迁移时
 * 由事件重建，从不直接写入磁盘。
 */
export interface AgentRuntimeState {
  /** 该状态描述的 agent。 */
  agentType: AgentType
  /** 当前的细粒度状态。 */
  state: TurnState
  /** agent 分配的会话 id（如已知）。 */
  externalSessionId?: string
  /** agent 分配给当前用户可见根轮次的 id（如已知）。 */
  externalTurnId?: string
  /** agent 正在工作的工作区路径。 */
  workspacePath?: string
  /** 使用的模型（如已知）。 */
  model?: string
  /** 当前模型配置的思考深度；未知时不从 token 用量推断。 */
  reasoningEffort?: string
  /**
   * 当前思考深度配置最近一次由原生 CLI 确认的时间（epoch 毫秒）。独立的
   * Claude 全局设置使用此字段，避免旧事件重新显示已移除的深度。
   */
  reasoningEffortObservedAt?: number
  /**
   * 当前模型配置在原始 CLI rollout 中的记录时间（epoch 毫秒）。用于拒绝
   * 晚到的旧配置快照，避免模型和思考深度在不同轮次之间交叉覆盖。
   */
  modelObservedAt?: number
  /** 当前活动的简短人类可读描述，例如 `"正在执行 npm test"`。 */
  activity?: string
  /** 当前正在运行的工具名（如适用）。 */
  toolName?: string
  /** 当前轮次内的工具调用次数。 */
  toolCallCount: number
  /** agent 是否在等待授权。 */
  needPermission: boolean
  /** agent 是否在等待用户输入。 */
  needUserInput: boolean
  /** AI 最后一条消息的摘要（如有捕获）。 */
  lastAssistantMessage?: string
  /** 本轮用户提问摘要（来自 prompt_submit 预览，供完成通知展示）。 */
  lastUserPrompt?: string
  /** 最新的 token/上下文用量（如已知）。 */
  token?: TokenPayload
  /** 当前轮次开始时间（epoch 毫秒，有活动轮次时存在）。 */
  turnStartedAt?: number
  /**
   * CLI 原生会话数据同步出的当前或最近完成轮次耗时。活动任务使用 `startedAt`
   * 持续递增；完成任务使用冻结的 `elapsedMs`，因此卡片不会重新显示为未知。
   */
  turnTiming?: TurnTiming
  /** 该 agent 最近一次事件的时间（epoch 毫秒）。 */
  lastEventAt: number
  /** Epoch milliseconds when the current terminal state was entered. */
  terminalAt?: number
  /** True when the task row has expired but retained account-level quota data remains. */
  taskHidden?: boolean
  /** 最近的终结结果是否仍未被用户确认（未读）。 */
  unread: boolean
}

/**
 * 由所有 agent 推导出的聚合托盘/总览状态（需求 §5.6）。
 *
 * 直接映射为托盘图标颜色。
 */
export type OverallState =
  | 'idle'
  | 'running'
  | 'attention'
  | 'done_unread'
  | 'error'
  | 'stuck'
  | 'limited'

/**
 * `GET /api/status` 返回并经 WebSocket 广播的快照。
 *
 * 包含各 agent 状态以及推导出的 {@link OverallState}。
 */
export interface StatusSnapshot {
  /** 提供给托盘的聚合指示。 */
  overall: OverallState
  /** 每个曾上报活动的 agent 各一条。 */
  agents: AgentRuntimeState[]
  /** 快照构建时间（epoch 毫秒）。 */
  updatedAt: number
}

/**
 * 面向未来 ESP32 / 硬件端点的极简状态
 * （`GET /api/device/status`，需求 §5.9）。刻意保持扁平、小巧，
 * 便于微控制器低成本解析。
 */
export interface DeviceStatus {
  /** 粗粒度总体状态字符串（如 `"waiting_permission"`）。 */
  mainState: string
  /** 当前最相关的 agent；空闲时为 `null`。 */
  activeAgent: AgentType | null
  /** 显示在设备上的简短消息。 */
  message: string
  /** Claude Code 的上下文已用百分比；未知时为 `null`。 */
  claudeContext: number | null
  /** Codex 的当前状态字符串；Codex 不存在时为 `null`。 */
  codexState: string | null
  /** 投影构建时间（epoch 毫秒）。 */
  updatedAt: number
}

/**
 * 通过 WebSocket 通道推送给渲染端/硬件客户端的消息。
 *
 * 以 `type` 为判别字段的可辨识联合：要么是新的状态快照，
 * 要么是一条通知请求。
 */
export type ServerPushMessage =
  | { type: 'status'; payload: StatusSnapshot }
  | { type: 'notification'; payload: NotificationRequest }

/**
 * 桌面通知的严重级别（需求 §5.7）。
 *
 * - `soft` —— 静默、信息性（如上下文超过 80%）。
 * - `normal` —— 某轮次已完成。
 * - `strong` —— 需要用户立刻处理（授权/输入/错误），带提示音。
 */
export type NotificationLevel = 'soft' | 'normal' | 'strong'

/** 用户在桌面端选择的界面语言，同时用于系统通知文案。 */
export type UiLocale = 'zh' | 'en'

/**
 * 由规则引擎产生的、展示一条通知的请求。
 *
 * 规则引擎在发出前已完成节流/去重；
 * 展示层只负责把它映射为操作系统通知。
 */
export interface NotificationRequest {
  /** 严重级别，控制展示方式与声音。 */
  level: NotificationLevel
  /** 通知标题。 */
  title: string
  /** 通知正文。 */
  body: string
  /** 通知涉及的 agent（如适用）。 */
  agentType?: AgentType
  /** 规则引擎用于节流重复通知的稳定键。 */
  dedupeKey: string
  /** 是否伴随提示音。 */
  sound: boolean
  /** 通知创建时间（epoch 毫秒）。 */
  createdAt: number
}

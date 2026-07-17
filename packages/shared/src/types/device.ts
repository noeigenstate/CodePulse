/**
 * 局域网水墨屏设备协议。这里的类型是跨进程、跨语言的稳定 JSON 契约，
 * 与仅供桌面 UI 使用的 {@link StatusSnapshot} 分开演进。
 *
 * @module shared/types/device
 */
import type { AgentType } from './agent.js'
import type { TokenAccuracy } from './token.js'

/** 当前局域网设备协议的主版本。破坏兼容性的变更必须增加该值。 */
export const DEVICE_PROTOCOL_VERSION = 1 as const

/** 水墨屏顶层展示使用的粗粒度状态。 */
export type DeviceMainState =
  | 'idle'
  | 'running'
  | 'waiting_permission'
  | 'done'
  | 'error'
  | 'stuck'
  | 'usage_limited'

/** Agent 状态机在设备协议中的稳定、小写表示。 */
export type DeviceAgentState =
  | 'idle'
  | 'prompt_submitted'
  | 'thinking'
  | 'tool_running'
  | 'waiting_permission'
  | 'waiting_user_input'
  | 'done'
  | 'error'
  | 'timeout'
  | 'usage_limited'
  | 'cancelled'

/** 一个 CLI 额度窗口。`resetsAt` 始终使用 Unix epoch 秒。 */
export interface DeviceQuotaWindowV1 {
  /** 已用百分比（0–100）；CLI 未上报时为 `null`。 */
  usedPercent: number | null
  /** 重置时间（Unix epoch 秒）；未知时为 `null`。 */
  resetsAt: number | null
  /** 窗口长度（分钟）；未知时为 `null`。 */
  windowMinutes: number | null
}

/** 同一账号/模型的一组短期与每周额度。 */
export interface DeviceQuotaBucketV1 {
  /** CLI 提供的稳定额度 id；缺失时由 CodePulse 生成稳定后备值。 */
  id: string
  /** 人类可读额度名称；未知时为 `null`。 */
  name: string | null
  /** 5 小时滚动窗口；该 CLI 未提供时为 `null`。 */
  fiveHour: DeviceQuotaWindowV1 | null
  /** 7 天/每周滚动窗口；该 CLI 未提供时为 `null`。 */
  weekly: DeviceQuotaWindowV1 | null
}

/** 水墨屏需要展示的一次 token / 上下文快照。 */
export interface DeviceTokenUsageV1 {
  input: number | null
  cachedInput: number | null
  output: number | null
  reasoningOutput: number | null
  total: number | null
  contextUsedPercent: number | null
  contextWindow: number | null
  contextStale: boolean
  contextCompressed: boolean
  accuracy: TokenAccuracy
}

/** 每种 CLI 最值得展示的一条聚合状态。 */
export interface DeviceAgentStatusV1 {
  type: AgentType
  state: DeviceAgentState
  /** 仅包含工作区目录名，不暴露绝对路径。 */
  project: string | null
  model: string | null
  activity: string | null
  needsAttention: boolean
  tokens: DeviceTokenUsageV1
  quotas: DeviceQuotaBucketV1[]
  /** 该 Agent 最近一次事件时间（Unix epoch 毫秒）。 */
  updatedAt: number
}

/** `GET /api/v1/device/status` 的完整 JSON 响应。 */
export interface DeviceStatusV1 {
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION
  /** 展示相关字段的稳定修订号；可用于跳过无变化的水墨屏刷新。 */
  revision: string
  mainState: DeviceMainState
  activeAgent: AgentType | null
  message: string
  agents: DeviceAgentStatusV1[]
  /** 所有 Agent 最近一次事件时间（Unix epoch 毫秒）；无事件时为 0。 */
  updatedAt: number
}

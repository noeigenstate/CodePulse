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

/** 固件通过 USB `getStatus` 返回的运行时阶段。 */
export type DeviceProvisionRuntimeState =
  | 'unprovisioned'
  | 'applying'
  | 'wifi_error'
  | 'desktop_unreachable'
  | 'ready'

/** App 已通过 CP1 `hello` 验证的 USB 水墨屏。 */
export interface CodePulseUsbDevice {
  path: string
  deviceId: string
  firmwareVersion: string
  hardwareRevision: number
  provisioned: boolean
  capabilities: string[]
  /** `getConfig` 只允许返回这些非敏感字段。 */
  config?: {
    wifiSsid: string
    serverId: string
    fallbackHost: string
    fallbackPort: number
  }
}

/** 通过 `_codepulse-dsp._tcp.local` 与匿名 health 双重验证的局域网水墨屏。 */
export interface CodePulseDisplayDevice {
  deviceId: string
  address: string
  port: number
  path: string
  firmwareVersion: string
  hardwareRevision: number
  provisioned: boolean
  lastSeenAt: number
}

/** 桌面端配网状态机；只有 `ready` 表示 USB 配网成功。 */
export type DeviceProvisioningPhase =
  | 'idle'
  | 'scanning'
  | 'sending'
  | DeviceProvisionRuntimeState
  | 'cancelled'
  | 'error'

/** 允许跨 IPC 返回的稳定错误码；不携带底层串口报错或敏感请求内容。 */
export type DeviceProvisioningErrorCode =
  | 'invalid_json'
  | 'invalid_request'
  | 'unsupported_protocol'
  | 'unknown_operation'
  | 'invalid_params'
  | 'line_too_long'
  | 'storage_error'
  | 'identity_error'
  | 'internal_error'
  | 'device_server_unavailable'
  | 'invalid_input'
  | 'serial_unavailable'
  | 'device_not_found'
  | 'device_mismatch'
  | 'timeout'
  | 'cancelled'
  | 'unknown'

/** Renderer 可读取的配网快照。密码与设备 token 永远不出现在该对象中。 */
export interface DeviceProvisioningSnapshot {
  serverAvailable: boolean
  serverId?: string
  serverPort?: number
  fallbackHost?: string
  scanning: boolean
  devices: CodePulseUsbDevice[]
  displays: CodePulseDisplayDevice[]
  phase: DeviceProvisioningPhase
  activeDeviceId?: string
  runtimeState?: DeviceProvisionRuntimeState
  errorCode?: DeviceProvisioningErrorCode
  updatedAt: number
}

/** 一次性 IPC 输入；调用方不得把 `wifiPassword` 写入持久化存储或日志。 */
export interface DeviceProvisioningRequest {
  path: string
  deviceId: string
  wifiSsid: string
  wifiPassword: string
  fallbackHost?: string
  fallbackPort?: number
}

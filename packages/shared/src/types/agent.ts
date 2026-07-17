/**
 * 描述 CodePulse 所监控的 AI 编程 agent 及其工作目录的领域类型。
 *
 * @module shared/types/agent
 */

/**
 * CodePulse 可监控的 AI 编程 agent 种类判别符。
 *
 * 在整个代码库中用作事件的 `source`，也是定位运行时状态槽位的键。
 */
export type AgentType = 'codex' | 'claude_code' | 'grok' | 'kimi'

/**
 * 一个被监控的 AI agent 及 CodePulse 掌握的安装信息。
 *
 * 这是 agent 的持久化描述（是否安装？hook 是否已配置？），
 * 与 {@link AgentRuntimeState}（运行中会话的实时活动）相区分。
 */
export interface Agent {
  /** 稳定的内部标识符。 */
  id: string
  /** agent 类型。 */
  type: AgentType
  /** 人类可读的显示名称，例如 `"Claude Code"`。 */
  name: string
  /** 是否在本机检测到该 agent 的 CLI。 */
  installed: boolean
  /** CodePulse 的 hook 是否已接入该 agent。 */
  configured: boolean
  /** 检测到的 CLI 版本字符串（如已知）。 */
  version?: string
  /** 最后一次收到该 agent 事件的时间（epoch 毫秒）。 */
  lastSeenAt?: number
}

/**
 * agent 正在操作的项目目录（工作区）。
 *
 * 工作区由事件携带的 `cwd` / workspace 路径推导而来，
 * 用于聚合会话并标注 Dashboard。
 */
export interface Workspace {
  /** 稳定的内部标识符。 */
  id: string
  /** 显示名称，通常是路径的最后一段。 */
  name: string
  /** 项目目录的绝对路径。 */
  path: string
  /** 当前 git 分支（由 status line 上报时存在）。 */
  gitBranch?: string
  /** 工作区最近活跃时间（epoch 毫秒）。 */
  lastActiveAt: number
}

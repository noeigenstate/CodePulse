/**
 * 聚合辅助函数：把各 agent 的运行时状态收敛为 UI 与硬件消费的视图 ——
 * 托盘总体指示、完整状态快照，以及极简设备投影。
 *
 * @module core/aggregate
 */
import {
  type AgentRuntimeState,
  type DeviceStatus,
  type OverallState,
  type StatusSnapshot,
  TurnState,
} from '@codepulse/shared'

/**
 * 把所有 agent 状态收敛为托盘图标的单一总体指示。
 *
 * 采用需求 §5.6 的颜色优先级
 * （error > attention > running > done-unread > idle），
 * 并对超时轮次额外提供「stuck」信号。
 *
 * @param agents 所有已知的 agent 运行时状态。
 * @returns 托盘应显示的唯一 {@link OverallState}。
 */
export function deriveOverall(agents: AgentRuntimeState[]): OverallState {
  const visibleAgents = agents.filter((agent) => !agent.taskHidden)
  if (visibleAgents.length === 0) return 'idle'
  const states = visibleAgents.map((a) => a.state)
  if (states.includes(TurnState.ERROR)) return 'error'
  if (states.includes(TurnState.USAGE_LIMITED)) return 'limited'
  if (states.includes(TurnState.TIMEOUT)) return 'stuck'
  if (
    states.includes(TurnState.WAITING_PERMISSION) ||
    states.includes(TurnState.WAITING_USER_INPUT)
  )
    return 'attention'
  if (
    states.includes(TurnState.PROMPT_SUBMITTED) ||
    states.includes(TurnState.THINKING) ||
    states.includes(TurnState.TOOL_RUNNING)
  )
    return 'running'
  if (visibleAgents.some((a) => a.state === TurnState.DONE && a.unread)) return 'done_unread'
  return 'idle'
}

/**
 * 把各 agent 状态包装为 {@link StatusSnapshot}：计算推导出的总体指示
 * 并盖上时间戳。
 *
 * @param agents 所有已知的 agent 运行时状态。
 * @param now 当前时间（epoch 毫秒，可注入便于测试）。
 * @returns `GET /api/status` 返回并经 WebSocket 推送的快照。
 */
export function buildStatusSnapshot(agents: AgentRuntimeState[], now = Date.now()): StatusSnapshot {
  return { overall: deriveOverall(agents), agents, updatedAt: now }
}

/**
 * 把完整状态快照投影为 `GET /api/device/status` 提供的极简硬件视图
 * （需求 §5.9）。
 *
 * 选取最值得关注的 agent（先 attention，再 running）作为 `activeAgent`，
 * 并暴露 Claude 的上下文百分比与 Codex 的状态。
 *
 * @param snapshot 待投影的完整状态快照。
 * @returns 适合 ESP32 客户端的扁平 {@link DeviceStatus}。
 */
export function toDeviceStatus(snapshot: StatusSnapshot): DeviceStatus {
  const visibleAgents = snapshot.agents.filter((agent) => !agent.taskHidden)
  const attention = visibleAgents.find(
    (a) => a.state === TurnState.WAITING_PERMISSION || a.state === TurnState.WAITING_USER_INPUT,
  )
  const running = visibleAgents.find(
    (a) =>
      a.state === TurnState.TOOL_RUNNING ||
      a.state === TurnState.THINKING ||
      a.state === TurnState.PROMPT_SUBMITTED,
  )
  const active = attention ?? running ?? visibleAgents[0] ?? null
  const claude =
    visibleAgents.find((a) => a.agentType === 'claude_code') ??
    snapshot.agents.find((a) => a.agentType === 'claude_code')
  const codex = visibleAgents.find((a) => a.agentType === 'codex')

  return {
    mainState: mapMainState(snapshot.overall),
    activeAgent: active?.agentType ?? null,
    message: active?.activity ?? overallMessage(snapshot.overall),
    claudeContext: claude?.token?.contextUsedPercent ?? null,
    codexState: codex ? codex.state : null,
    updatedAt: snapshot.updatedAt,
  }
}

/**
 * 把总体指示映射为设备 API 暴露的紧凑 `mainState` 字符串。
 *
 * @param overall 聚合后的总体状态。
 * @returns 小写、设备友好的状态字符串。
 */
function mapMainState(overall: OverallState): string {
  switch (overall) {
    case 'attention':
      return 'waiting_permission'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    case 'limited':
      return 'usage_limited'
    case 'done_unread':
      return 'done'
    case 'stuck':
      return 'stuck'
    case 'idle':
    default:
      return 'idle'
  }
}

/**
 * 当没有 agent 活动描述可用时，为设备提供默认中文消息。
 *
 * @param overall 聚合后的总体状态。
 * @returns 简短的人类可读状态消息。
 */
function overallMessage(overall: OverallState): string {
  switch (overall) {
    case 'attention':
      return '需要用户介入'
    case 'running':
      return 'AI 正在执行'
    case 'error':
      return '执行出错'
    case 'limited':
      return '已达用量上限'
    case 'done_unread':
      return '一轮任务已完成'
    case 'stuck':
      return '疑似卡住'
    default:
      return '空闲'
  }
}

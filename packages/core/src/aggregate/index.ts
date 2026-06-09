/**
 * Aggregation helpers that collapse per-agent runtime states into the views the
 * UI and hardware consume: the overall tray indicator, the full status
 * snapshot, and the minimal device projection.
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
 * Collapses all agent states into one overall indicator for the tray icon.
 *
 * Uses the colour priority from requirements §5.6
 * (error > attention > running > done-unread > idle), with an additional
 * "stuck" signal for timed-out turns.
 *
 * @param agents All known per-agent runtime states.
 * @returns The single {@link OverallState} the tray should show.
 */
export function deriveOverall(agents: AgentRuntimeState[]): OverallState {
  if (agents.length === 0) return 'idle'
  const states = agents.map((a) => a.state)
  if (states.includes(TurnState.ERROR)) return 'error'
  if (states.includes(TurnState.TIMEOUT)) return 'stuck'
  if (states.includes(TurnState.WAITING_PERMISSION) || states.includes(TurnState.WAITING_USER_INPUT))
    return 'attention'
  if (
    states.includes(TurnState.PROMPT_SUBMITTED) ||
    states.includes(TurnState.THINKING) ||
    states.includes(TurnState.TOOL_RUNNING)
  )
    return 'running'
  if (agents.some((a) => a.state === TurnState.DONE && a.unread)) return 'done_unread'
  return 'idle'
}

/**
 * Wraps the per-agent states in a {@link StatusSnapshot}, computing the derived
 * overall indicator and stamping the time.
 *
 * @param agents All known per-agent runtime states.
 * @param now Current time in epoch millis (injectable for testing).
 * @returns The snapshot returned by `GET /api/status` and pushed over the WS.
 */
export function buildStatusSnapshot(
  agents: AgentRuntimeState[],
  now = Date.now(),
): StatusSnapshot {
  return { overall: deriveOverall(agents), agents, updatedAt: now }
}

/**
 * Projects a full status snapshot down to the minimal hardware view served by
 * `GET /api/device/status` (requirements §5.9).
 *
 * Picks the most action-worthy agent (attention first, then running) as the
 * `activeAgent` and surfaces Claude's context percentage and Codex's state.
 *
 * @param snapshot The full status snapshot to project.
 * @returns A flat {@link DeviceStatus} suitable for an ESP32 client.
 */
export function toDeviceStatus(snapshot: StatusSnapshot): DeviceStatus {
  const attention = snapshot.agents.find(
    (a) => a.state === TurnState.WAITING_PERMISSION || a.state === TurnState.WAITING_USER_INPUT,
  )
  const running = snapshot.agents.find(
    (a) =>
      a.state === TurnState.TOOL_RUNNING ||
      a.state === TurnState.THINKING ||
      a.state === TurnState.PROMPT_SUBMITTED,
  )
  const active = attention ?? running ?? snapshot.agents[0] ?? null
  const claude = snapshot.agents.find((a) => a.agentType === 'claude_code')
  const codex = snapshot.agents.find((a) => a.agentType === 'codex')

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
 * Maps the overall indicator to the compact `mainState` string the device API
 * exposes.
 *
 * @param overall The aggregated overall state.
 * @returns A lowercase device-friendly state string.
 */
function mapMainState(overall: OverallState): string {
  switch (overall) {
    case 'attention':
      return 'waiting_permission'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
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
 * Provides a default Chinese message for the device when no agent activity
 * string is available.
 *
 * @param overall The aggregated overall state.
 * @returns A short human-readable status message.
 */
function overallMessage(overall: OverallState): string {
  switch (overall) {
    case 'attention':
      return '需要用户介入'
    case 'running':
      return 'AI 正在执行'
    case 'error':
      return '执行出错'
    case 'done_unread':
      return '一轮任务已完成'
    case 'stuck':
      return '疑似卡住'
    default:
      return '空闲'
  }
}

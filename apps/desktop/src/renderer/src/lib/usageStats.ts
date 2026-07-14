import {
  formatTokenPercent,
  TurnState,
  type AgentRuntimeState,
  type AgentType,
} from '@codepulse/shared'
import type { AgentPanel } from './displayAgents.js'
import { visibleRateLimitWindows } from './panelFormat.js'

export interface AgentUsageRow {
  agentType: AgentType
  name: string
  projects: number
  running: number
  waiting: number
  unread: number
  models: string[]
  weeklyUsedPercent?: number
  fiveHourUsedPercent?: number
}

export interface UsageStats {
  panelCount: number
  projectCount: number
  runningCount: number
  waitingCount: number
  unreadCount: number
  agents: AgentUsageRow[]
  models: string[]
  updatedAt: number
}

const ACTIVE: ReadonlySet<TurnState> = new Set([
  TurnState.PROMPT_SUBMITTED,
  TurnState.THINKING,
  TurnState.TOOL_RUNNING,
])

const WAITING: ReadonlySet<TurnState> = new Set([
  TurnState.WAITING_PERMISSION,
  TurnState.WAITING_USER_INPUT,
])

/** Build a lightweight local usage snapshot from live dashboard state (no network). */
export function buildUsageStats(panels: AgentPanel[], updatedAt: number): UsageStats {
  const agents: AgentUsageRow[] = panels.map((panel) => {
    const visible = panel.workspaces.filter((item) => !item.agent.taskHidden)
    const running = visible.filter((item) => ACTIVE.has(item.agent.state)).length
    const waiting = visible.filter((item) => WAITING.has(item.agent.state)).length
    const unread = visible.filter((item) => item.agent.unread).length
    const models = unique(
      visible.map((item) => item.agent.model).filter((model): model is string => Boolean(model)),
    )
    const windows = visibleRateLimitWindows(panel.quotaToken, panel.agentType)
    return {
      agentType: panel.agentType,
      name: panel.name,
      projects: visible.length,
      running,
      waiting,
      unread,
      models,
      weeklyUsedPercent: windows.sevenDay?.usedPercent,
      fiveHourUsedPercent: windows.fiveHour?.usedPercent,
    }
  })

  return {
    panelCount: panels.length,
    projectCount: agents.reduce((sum, row) => sum + row.projects, 0),
    runningCount: agents.reduce((sum, row) => sum + row.running, 0),
    waitingCount: agents.reduce((sum, row) => sum + row.waiting, 0),
    unreadCount: agents.reduce((sum, row) => sum + row.unread, 0),
    agents,
    models: unique(agents.flatMap((row) => row.models)),
    updatedAt,
  }
}

export function formatQuotaPercent(value: number | undefined): string {
  return formatTokenPercent(value)
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

/** Count agents that still hold runtime state (including hidden task shells with quota). */
export function countTrackedAgents(agents: AgentRuntimeState[]): number {
  return agents.length
}

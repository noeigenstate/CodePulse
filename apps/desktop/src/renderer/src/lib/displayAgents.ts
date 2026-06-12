import {
  TurnState,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  workspaceKey,
} from '@codepulse/shared'
import { visibleRateLimitWindows } from './panelFormat.js'

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex']

export interface WorkspaceAgentGroup {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  token?: TokenPayload
  agents: AgentRuntimeState[]
}

export interface AgentWorkspaceItem {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  agent: AgentRuntimeState
}

export interface AgentPanel {
  agentType: AgentType
  name: string
  updatedAt: number
  quotaToken?: TokenPayload
  workspaces: AgentWorkspaceItem[]
}

export function buildDisplayAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  return (
    buildWorkspaceAgentGroups(agents)[0]?.agents ??
    DISPLAY_AGENT_ORDER.map((type) => idleAgent(type))
  )
}

export function buildAgentPanels(agents: AgentRuntimeState[]): AgentPanel[] {
  return DISPLAY_AGENT_ORDER.map((agentType) => {
    const typeAgents = agents.filter((agent) => agent.agentType === agentType)
    const workspaces = buildAgentWorkspaceItems(agentType, typeAgents)
    return {
      agentType,
      name: agentType === 'codex' ? 'Codex' : 'Claude Code',
      updatedAt: Math.max(0, ...workspaces.map((workspace) => workspace.updatedAt)),
      quotaToken: latestQuotaToken(workspaces.map((workspace) => workspace.agent)),
      workspaces,
    }
  })
}

export function latestQuotaToken(agents: AgentRuntimeState[]): TokenPayload | undefined {
  return agents
    .filter((agent) => hasVisibleRateLimits(agent.token))
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]?.token
}

export function buildWorkspaceAgentGroups(agents: AgentRuntimeState[]): WorkspaceAgentGroup[] {
  const grouped = new Map<string, AgentRuntimeState[]>()

  for (const agent of agents) {
    const key = workspaceKey(agent.workspacePath)
    grouped.set(key, [...(grouped.get(key) ?? []), agent])
  }

  if (grouped.size === 0) grouped.set('', [])

  return [...grouped.entries()]
    .map(([key, groupAgents]) => {
      const workspacePath = groupAgents.find((agent) => agent.workspacePath)?.workspacePath
      const byType = new Map(groupAgents.map((agent) => [agent.agentType, agent]))
      const primary = DISPLAY_AGENT_ORDER.map(
        (agentType) => byType.get(agentType) ?? idleAgent(agentType, workspacePath),
      )
      const extras = groupAgents.filter((agent) => !DISPLAY_AGENT_ORDER.includes(agent.agentType))
      const ordered = [...primary, ...extras]
      const updatedAt = Math.max(0, ...groupAgents.map((agent) => agent.lastEventAt))

      return {
        id: key || 'workspace:unknown',
        name: workspacePath ? workspaceName(workspacePath) : '未识别项目',
        workspacePath,
        updatedAt,
        token: latestToken(groupAgents),
        agents: ordered,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

function buildAgentWorkspaceItems(
  agentType: AgentType,
  agents: AgentRuntimeState[],
): AgentWorkspaceItem[] {
  const grouped = new Map<string, AgentRuntimeState[]>()

  for (const agent of agents) {
    const key = workspaceKey(agent.workspacePath)
    grouped.set(key, [...(grouped.get(key) ?? []), agent])
  }

  if (grouped.size === 0) grouped.set('', [idleAgent(agentType)])

  return [...grouped.entries()]
    .map(([key, groupAgents]) => {
      const latest =
        [...groupAgents].sort((a, b) => b.lastEventAt - a.lastEventAt)[0] ?? idleAgent(agentType)
      const workspacePath =
        latest.workspacePath ?? groupAgents.find((agent) => agent.workspacePath)?.workspacePath

      return {
        id: `${agentType}:${key || 'unknown'}`,
        name: workspacePath ? workspaceName(workspacePath) : '未识别项目',
        workspacePath,
        updatedAt: latest.lastEventAt,
        agent: workspacePath && !latest.workspacePath ? { ...latest, workspacePath } : latest,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

function idleAgent(agentType: AgentType, workspacePath?: string): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    activity: '等待事件',
    lastEventAt: 0,
    unread: false,
    workspacePath,
  }
}

function latestToken(agents: AgentRuntimeState[]): TokenPayload | undefined {
  return agents.filter((agent) => agent.token).sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
    ?.token
}

function hasVisibleRateLimits(token: TokenPayload | undefined): boolean {
  const windows = visibleRateLimitWindows(token)
  return Boolean(windows.fiveHour ?? windows.sevenDay)
}

function workspaceName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

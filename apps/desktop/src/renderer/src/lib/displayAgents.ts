import {
  TurnState,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  workspaceKey,
} from '@codepulse/shared'
import { visibleRateLimitWindows } from './panelFormat.js'

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex']
const QUOTA_RECENCY_WINDOW_MS = 30 * 60_000

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
      quotaToken: latestQuotaToken(typeAgents, preferredQuotaModel(typeAgents)),
      workspaces,
    }
  })
}

export function latestQuotaToken(
  agents: AgentRuntimeState[],
  preferredModel?: string,
): TokenPayload | undefined {
  const candidates = agents.filter((agent) => hasVisibleRateLimits(agent.token))
  if (candidates.length === 0) return undefined

  const freshestAt = Math.max(...candidates.map((agent) => agent.lastEventAt))
  const recent = candidates.filter(
    (agent) => freshestAt - agent.lastEventAt <= QUOTA_RECENCY_WINDOW_MS,
  )
  const timePool = recent.length > 0 ? recent : candidates
  const modelPool = preferredModel
    ? timePool.filter((agent) => sameModel(agent.model, preferredModel))
    : []
  const pool = modelPool.length > 0 ? modelPool : timePool

  return [...pool].sort(compareQuotaCandidates)[0]?.token
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

function compareQuotaCandidates(a: AgentRuntimeState, b: AgentRuntimeState): number {
  return b.lastEventAt - a.lastEventAt || quotaPressure(b.token) - quotaPressure(a.token)
}

function quotaPressure(token: TokenPayload | undefined): number {
  const windows = visibleRateLimitWindows(token)
  return Math.max(
    normalizedPercent(windows.fiveHour?.usedPercent),
    normalizedPercent(windows.sevenDay?.usedPercent),
  )
}

function preferredQuotaModel(agents: AgentRuntimeState[]): string | undefined {
  const latestActive = agents
    .filter((agent) => isActiveState(agent.state) && agent.model)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
  const latest = [...agents]
    .filter((agent) => agent.model)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
  return latestActive?.model ?? latest?.model
}

function isActiveState(state: TurnState): boolean {
  return (
    state === TurnState.PROMPT_SUBMITTED ||
    state === TurnState.THINKING ||
    state === TurnState.TOOL_RUNNING ||
    state === TurnState.WAITING_PERMISSION ||
    state === TurnState.WAITING_USER_INPUT
  )
}

function sameModel(a: string | undefined, b: string): boolean {
  return normalizeModel(a) === normalizeModel(b)
}

function normalizeModel(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function normalizedPercent(value: number | undefined): number {
  return value != null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : -1
}

function workspaceName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

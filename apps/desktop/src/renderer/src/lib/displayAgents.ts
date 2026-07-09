import {
  TurnState,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type TokenQuotaBucket,
  workspaceKey,
} from '@codepulse/shared'
import { visibleRateLimitWindows } from './panelFormat.js'

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex', 'grok']
const QUOTA_RECENCY_WINDOW_MS = 30 * 60_000

/** 人类可读的 agent 显示名称。 */
export function agentDisplayName(agentType: AgentType): string {
  if (agentType === 'codex') return 'Codex'
  if (agentType === 'grok') return 'Grok'
  return 'Claude Code'
}

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

interface QuotaCandidate {
  agent: AgentRuntimeState
  token: TokenPayload
  updatedAt: number
}

export function buildDisplayAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  return (
    buildWorkspaceAgentGroups(visibleTaskAgents(agents))[0]?.agents ??
    DISPLAY_AGENT_ORDER.map((type) => idleAgent(type))
  )
}

/**
 * 按 agent 类型构建 Dashboard 分屏。
 * 仅在该 CLI 已有可见任务/项目或额度数据时返回对应分屏（自适应 1～3 栏）。
 * 项目行被隐藏后仍会保留额度条，直到该 agent 状态槽位被清理。
 */
export function buildAgentPanels(agents: AgentRuntimeState[]): AgentPanel[] {
  return DISPLAY_AGENT_ORDER.flatMap((agentType) => {
    const typeAgents = agents.filter((agent) => agent.agentType === agentType)
    if (typeAgents.length === 0) return []

    const workspaces = buildAgentWorkspaceItems(agentType, visibleTaskAgents(typeAgents))
    const quotaToken = latestQuotaToken(typeAgents, preferredQuotaModel(typeAgents))
    // 无项目且无额度时不分屏；用户开启对应 CLI 任务后再出现
    if (workspaces.length === 0 && !quotaToken) return []

    return [
      {
        agentType,
        name: agentDisplayName(agentType),
        updatedAt: Math.max(
          0,
          ...workspaces.map((workspace) => workspace.updatedAt),
          ...typeAgents.map((agent) => agent.lastEventAt),
        ),
        quotaToken,
        workspaces,
      },
    ]
  })
}

export function latestQuotaToken(
  agents: AgentRuntimeState[],
  preferredModel?: string,
): TokenPayload | undefined {
  const candidates = agents.flatMap(quotaCandidatesForAgent)
  if (candidates.length === 0) return undefined

  const compatiblePool = preferredModel
    ? candidates.filter((candidate) => quotaMatchesPreferredModel(candidate.token, preferredModel))
    : candidates
  const selectionBase = compatiblePool.length > 0 ? compatiblePool : candidates

  const modelPool = preferredModel
    ? selectionBase.filter((candidate) => sameModel(candidate.agent.model, preferredModel))
    : []
  const modelBase = modelPool.length > 0 ? modelPool : selectionBase
  const freshestAt = Math.max(...modelBase.map((candidate) => candidate.updatedAt))
  const recent = modelBase.filter(
    (candidate) => freshestAt - candidate.updatedAt <= QUOTA_RECENCY_WINDOW_MS,
  )
  const pool = recent.length > 0 ? recent : modelBase

  return [...pool].sort(compareQuotaCandidates)[0]?.token
}

export function buildWorkspaceAgentGroups(agents: AgentRuntimeState[]): WorkspaceAgentGroup[] {
  const grouped = new Map<string, AgentRuntimeState[]>()

  for (const agent of visibleTaskAgents(agents)) {
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
        name: workspacePath ? workspaceName(workspacePath) : '',
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

  return [...grouped.entries()]
    .map(([key, groupAgents]) => {
      const latest =
        [...groupAgents].sort((a, b) => b.lastEventAt - a.lastEventAt)[0] ?? idleAgent(agentType)
      const workspacePath =
        latest.workspacePath ?? groupAgents.find((agent) => agent.workspacePath)?.workspacePath

      return {
        id: `${agentType}:${key || 'unknown'}`,
        name: workspacePath ? workspaceName(workspacePath) : '',
        workspacePath,
        updatedAt: latest.lastEventAt,
        agent: workspacePath && !latest.workspacePath ? { ...latest, workspacePath } : latest,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

function visibleTaskAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  return agents.filter((agent) => !agent.taskHidden)
}

function idleAgent(agentType: AgentType, workspacePath?: string): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    activity: undefined,
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

function quotaCandidatesForAgent(agent: AgentRuntimeState): QuotaCandidate[] {
  const token = agent.token
  if (!token) return []

  const bucketCandidates = Object.entries(token.quotaBuckets ?? {})
    .map(([, bucket]) => quotaCandidateFromBucket(agent, token, bucket))
    .filter((candidate): candidate is QuotaCandidate => Boolean(candidate))

  if (bucketCandidates.length > 0) return bucketCandidates
  return hasVisibleRateLimits(token) ? [{ agent, token, updatedAt: agent.lastEventAt }] : []
}

function quotaCandidateFromBucket(
  agent: AgentRuntimeState,
  baseToken: TokenPayload,
  bucket: TokenQuotaBucket,
): QuotaCandidate | undefined {
  const token: TokenPayload = {
    ...baseToken,
    rateLimitId: bucket.rateLimitId,
    rateLimitName: bucket.rateLimitName,
    rateLimits: bucket.rateLimits,
  }
  if (!hasVisibleRateLimits(token)) return undefined
  return { agent, token, updatedAt: bucket.updatedAt ?? agent.lastEventAt }
}

function compareQuotaCandidates(a: QuotaCandidate, b: QuotaCandidate): number {
  return b.updatedAt - a.updatedAt || quotaPressure(b.token) - quotaPressure(a.token)
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

function quotaMatchesPreferredModel(
  token: TokenPayload | undefined,
  preferredModel: string,
): boolean {
  const bucket = normalizeModel(`${token?.rateLimitId ?? ''} ${token?.rateLimitName ?? ''}`)
  if (!bucket) return true

  const preferred = normalizeModel(preferredModel)
  const preferredSpark = isSparkModel(preferred)
  const bucketSpark = isSparkQuota(bucket)
  if (bucketSpark !== preferredSpark && (bucketSpark || isDefaultCodexQuota(bucket))) return false

  const quotaVersion = extractGptVersion(bucket)
  const preferredVersion = extractGptVersion(preferred)
  if (quotaVersion && preferredVersion && quotaVersion !== preferredVersion) return false

  return true
}

function isDefaultCodexQuota(value: string): boolean {
  return value.split(/\s+/).includes('codex')
}

function isSparkQuota(value: string): boolean {
  return value.includes('spark') || value.includes('bengalfox')
}

function isSparkModel(value: string): boolean {
  return value.includes('spark') || value.includes('5.3')
}

function extractGptVersion(value: string): string | undefined {
  return value.match(/gpt[-_\s]*(\d+(?:\.\d+)?)/)?.[1]
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

import { workspaceKey, type AgentRuntimeState, type AgentType } from '@codepulse/shared'
import type { AgentPanel } from './displayAgents.js'
import { hudStatePriority } from './hudState.js'
import { visibleRateLimitWindows } from './panelFormat.js'

export interface ProjectDeckSource {
  agentType: AgentType
  agent: AgentRuntimeState
}

export interface ProjectDeckItem {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  sources: ProjectDeckSource[]
  primary: ProjectDeckSource
}

export interface ProjectUsageSummary {
  agentType: AgentType
  label: string
  /** 5-hour window percent, when the provider exposes one. */
  fiveHourPercent?: number
  /** Weekly window percent, when the provider exposes one. */
  sevenDayPercent?: number
}

interface MutableDeckItem {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  sources: ProjectDeckSource[]
}

/** Builds one global project collection from provider-specific runtime panels. */
export function buildProjectDeckItems(panels: readonly AgentPanel[]): ProjectDeckItem[] {
  const grouped = new Map<string, MutableDeckItem>()

  for (const panel of panels) {
    for (const workspace of panel.workspaces) {
      const normalizedPath = workspaceKey(workspace.workspacePath)
      const key = normalizedPath || `${panel.agentType}:${workspace.id}`
      const source = { agentType: panel.agentType, agent: workspace.agent }
      const existing = grouped.get(key)
      if (existing) {
        existing.sources.push(source)
        existing.updatedAt = Math.max(existing.updatedAt, workspace.updatedAt)
        if (!existing.name && workspace.name) existing.name = workspace.name
        if (!existing.workspacePath && workspace.workspacePath) {
          existing.workspacePath = workspace.workspacePath
        }
        continue
      }

      grouped.set(key, {
        id: key,
        name: workspace.name,
        workspacePath: workspace.workspacePath,
        updatedAt: workspace.updatedAt,
        sources: [source],
      })
    }
  }

  return [...grouped.values()]
    .map((item) => ({ ...item, primary: choosePrimarySource(item.sources) }))
    .sort(compareProjectDeckItems)
}

/** Provider quotas remain available without creating provider-sized empty panels. */
export function buildProjectUsageSummaries(panels: readonly AgentPanel[]): ProjectUsageSummary[] {
  return panels.flatMap((panel) => {
    let fiveHour: number | undefined
    let sevenDay: number | undefined
    for (const meter of panel.quotaMeters) {
      const windows = visibleRateLimitWindows(meter.token, panel.agentType)
      const five = windows.fiveHour?.usedPercent
      const seven = windows.sevenDay?.usedPercent
      if (five != null && Number.isFinite(five)) fiveHour = Math.max(fiveHour ?? five, five)
      if (seven != null && Number.isFinite(seven)) sevenDay = Math.max(sevenDay ?? seven, seven)
    }
    if (fiveHour == null && sevenDay == null) return []
    // Both windows matter to the user (notably Claude's 5-hour + weekly
    // quotas), so keep them side by side on one label instead of collapsing.
    return [
      {
        agentType: panel.agentType,
        label: projectSourceLabel(panel.agentType),
        ...(fiveHour != null ? { fiveHourPercent: clampPercent(fiveHour) } : {}),
        ...(sevenDay != null ? { sevenDayPercent: clampPercent(sevenDay) } : {}),
      },
    ]
  })
}

export function projectSourceLabel(agentType: AgentType): string {
  if (agentType === 'claude_code') return 'CLAUDE'
  if (agentType === 'codex') return 'CODEX'
  if (agentType === 'grok') return 'GROK'
  if (agentType === 'kimi') return 'KIMI'
  return String(agentType).toUpperCase()
}

function choosePrimarySource(sources: readonly ProjectDeckSource[]): ProjectDeckSource {
  return [...sources].sort(
    (left, right) =>
      hudStatePriority(right.agent) - hudStatePriority(left.agent) ||
      right.agent.lastEventAt - left.agent.lastEventAt ||
      projectSourceLabel(left.agentType).localeCompare(projectSourceLabel(right.agentType)),
  )[0]!
}

/**
 * Implicit provider order for the HUD: Claude first, then Codex, Kimi, Grok.
 * Cards within one provider keep their first-seen order (the sort is stable and
 * the panels arrive pre-ordered by the persisted project order).
 */
function agentTypeRank(agentType: AgentType): number {
  if (agentType === 'claude_code') return 0
  if (agentType === 'codex') return 1
  if (agentType === 'kimi') return 2
  if (agentType === 'grok') return 3
  return Number.MAX_SAFE_INTEGER - 1
}

function compareProjectDeckItems(left: ProjectDeckItem, right: ProjectDeckItem): number {
  // Equal ranks return 0 on purpose: Array.prototype.sort is stable, so the
  // first-seen panel order breaks ties inside one provider (先到先得).
  return agentTypeRank(left.primary.agentType) - agentTypeRank(right.primary.agentType)
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

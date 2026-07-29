import { workspaceKey, type AgentRuntimeState, type AgentType } from '@codepulse/shared'
import type { AgentPanel } from './displayAgents.js'
import { visibleRateLimitWindows } from './panelFormat.js'

/** One agent's independent card inside a project group. */
export interface ProjectDeckCard {
  id: string
  agentType: AgentType
  agent: AgentRuntimeState
  updatedAt: number
}

/**
 * One project on the HUD. Every agent working in the project gets its own
 * card (states are independent and cannot be merged), and the group wrapper
 * keeps same-project cards visually together.
 */
export interface ProjectDeckGroup {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  cards: ProjectDeckCard[]
}

export interface ProjectUsageSummary {
  agentType: AgentType
  label: string
  /** 5-hour window percent, when the provider exposes one. */
  fiveHourPercent?: number
  /** Weekly window percent, when the provider exposes one. */
  sevenDayPercent?: number
}

interface MutableDeckGroup {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  cards: ProjectDeckCard[]
}

/**
 * Builds project groups from provider-specific runtime panels. Agents sharing
 * one workspace stay in the same group but each keeps its own card, so state
 * and acknowledgement remain fully independent per agent.
 */
export function buildProjectDeckGroups(panels: readonly AgentPanel[]): ProjectDeckGroup[] {
  const grouped = new Map<string, MutableDeckGroup>()

  for (const panel of panels) {
    for (const workspace of panel.workspaces) {
      const normalizedPath = workspaceKey(workspace.workspacePath)
      const key = normalizedPath || `${panel.agentType}:${workspace.id}`
      const card: ProjectDeckCard = {
        id: `${key}:${panel.agentType}`,
        agentType: panel.agentType,
        agent: workspace.agent,
        updatedAt: workspace.updatedAt,
      }
      const existing = grouped.get(key)
      if (existing) {
        existing.cards.push(card)
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
        cards: [card],
      })
    }
  }

  for (const group of grouped.values()) {
    group.cards.sort(
      (left, right) => agentTypeRank(left.agentType) - agentTypeRank(right.agentType),
    )
  }

  return [...grouped.values()].sort((left, right) => groupRank(left) - groupRank(right))
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

/**
 * A group ranks by its front-most provider, so a project with a Claude card
 * still leads the Codex-only projects. Equal ranks return 0 on purpose: the
 * sort is stable and first-seen panel order breaks ties (先到先得).
 */
function groupRank(group: ProjectDeckGroup): number {
  return Math.min(...group.cards.map((card) => agentTypeRank(card.agentType)))
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

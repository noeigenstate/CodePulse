import { buildStatusSnapshot } from '@codepulse/core'
import {
  TurnState,
  workspaceKey,
  type AgentRuntimeState,
  type StatusSnapshot,
} from '@codepulse/shared'
import { HudWorkspaces, hudRowKey, hudWorkspacePath, isHudProjectRoot } from './hud-workspaces.js'

/** HUD 1.4 supports these renderers; newer providers stay visible in the full console. */
export const HUD_AGENT_TYPES = new Set(['claude_code', 'codex', 'grok', 'kimi'])

const rowKey = hudRowKey

/** Quota/timestamp refreshes do not resurrect a card dismissed in this surface. */
function activityKey(agent: AgentRuntimeState): string {
  return JSON.stringify([
    agent.externalTurnId,
    agent.turnStartedAt,
    agent.state,
    agent.toolCallCount,
    agent.activity,
    agent.lastUserPrompt,
    agent.lastAssistantMessage,
  ])
}

/** Presentation state only. The canonical hub, dashboard and device API are never mutated. */
export class HudProjection {
  private hidden = new Map<string, string>()
  private retentionMinutes = 30
  private workspaces: HudWorkspaces

  constructor(path?: string, onError?: (error: unknown) => void) {
    this.workspaces = new HudWorkspaces(path, onError)
  }

  /** Resolve a displayed project back to canonical sessions, not their tool cwd.
   * Nested workspaces may be coalesced into a parent card by the HUD renderer.
   * Pathless "read all" keeps the existing provider-wide acknowledgement contract.
   */
  rowsForProject(source: StatusSnapshot, type: unknown, workspace?: string): AgentRuntimeState[] {
    const path = workspaceKey(hudWorkspacePath(workspace))
    const rows = this.workspaces.project(
      source.agents.filter((agent) => HUD_AGENT_TYPES.has(agent.agentType)),
    )
    const keys = new Set(
      rows
        .filter((agent) => {
          if (agent.agentType !== type) return false
          const candidate = workspaceKey(agent.workspacePath)
          return (
            !path ||
            candidate === path ||
            (isHudProjectRoot(path) && candidate.startsWith(`${path}/`))
          )
        })
        .map(rowKey),
    )
    return source.agents.filter((agent) => keys.has(rowKey(agent)))
  }

  /** A task card acknowledges only its native session, even if tool cwd moved.
   * Missing session means the legacy project/read-all contract; an invalid or
   * unknown explicit session must never widen into project acknowledgement.
   */
  rowsForCard(
    source: StatusSnapshot,
    type: unknown,
    workspace?: string,
    session?: string,
  ): AgentRuntimeState[] {
    if (session !== undefined) {
      if (typeof session !== 'string' || !session.trim() || !HUD_AGENT_TYPES.has(String(type)))
        return []
      return source.agents.filter(
        (agent) => agent.agentType === type && agent.externalSessionId === session,
      )
    }
    return this.rowsForProject(source, type, workspace)
  }

  setRetention(value: unknown): boolean {
    if (typeof value !== 'number' || ![10, 30, 60, 120, 240].includes(value)) return false
    this.retentionMinutes = value
    return true
  }

  dismiss(snapshot: StatusSnapshot, type: unknown, workspace?: string, session?: string): boolean {
    const rows = session
      ? snapshot.agents.filter(
          (agent) => agent.agentType === type && agent.externalSessionId === session,
        )
      : this.rowsForProject(snapshot, type, workspace).filter(
          (agent) => workspace || !hudWorkspacePath(agent.workspacePath),
        )
    for (const agent of rows) this.hidden.set(rowKey(agent), activityKey(agent))
    return rows.length > 0
  }

  /** Used both for rendering and the hub's source-retention guard. */
  shouldRetain(agent: Readonly<AgentRuntimeState>, now: number): boolean {
    if (!HUD_AGENT_TYPES.has(agent.agentType) || agent.taskHidden) return false
    const dismissedActivity = this.hidden.get(rowKey(agent))
    if (dismissedActivity !== undefined && dismissedActivity === activityKey(agent)) return false
    const quiet =
      agent.state === TurnState.IDLE ||
      agent.state === TurnState.CANCELLED ||
      (!agent.unread &&
        [TurnState.DONE, TurnState.ERROR, TurnState.TIMEOUT, TurnState.USAGE_LIMITED].some(
          (state) => state === agent.state,
        ))
    const anchor = agent.terminalAt ?? agent.lastEventAt
    return !quiet || anchor <= 0 || now - anchor < this.retentionMinutes * 60_000
  }

  snapshot(source: StatusSnapshot, now = Date.now()): StatusSnapshot {
    const retained = new Set<string>()
    const agents = this.workspaces
      .project(source.agents.filter((agent) => HUD_AGENT_TYPES.has(agent.agentType)))
      .map((agent) => {
        const key = rowKey(agent)
        retained.add(key)
        const hiddenActivity = this.hidden.get(key)
        if (hiddenActivity && hiddenActivity !== activityKey(agent)) this.hidden.delete(key)
        return this.shouldRetain(agent, now) ? agent : { ...agent, taskHidden: true }
      })
    for (const key of this.hidden.keys()) if (!retained.has(key)) this.hidden.delete(key)
    return buildStatusSnapshot(agents, now)
  }
}

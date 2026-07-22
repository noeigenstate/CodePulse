import { TurnState, type AgentRuntimeState } from '@codepulse/shared'

/**
 * Visual hierarchy used by the desktop HUD.
 *
 * The runtime state remains transport- and device-neutral. This projection is
 * intentionally small: neutral states use typography and motion, while orange
 * is reserved for a project that actually needs the user's attention.
 */
export type HudStateLevel = 'quiet' | 'active' | 'notice' | 'action' | 'fault'

export type HudStateSource = Pick<AgentRuntimeState, 'state' | 'unread'>

/** Maps one project state to the desktop HUD's restrained visual hierarchy. */
export function hudStateLevel(agent: HudStateSource): HudStateLevel {
  if (
    agent.state === TurnState.WAITING_PERMISSION ||
    agent.state === TurnState.WAITING_USER_INPUT
  ) {
    return 'action'
  }

  if (
    agent.unread &&
    (agent.state === TurnState.ERROR ||
      agent.state === TurnState.TIMEOUT ||
      agent.state === TurnState.USAGE_LIMITED)
  ) {
    return 'fault'
  }

  if (agent.unread && agent.state === TurnState.DONE) return 'notice'

  if (
    agent.state === TurnState.PROMPT_SUBMITTED ||
    agent.state === TurnState.THINKING ||
    agent.state === TurnState.TOOL_RUNNING
  ) {
    return 'active'
  }

  return 'quiet'
}

/** Whether a project should receive the HUD's single orange attention color. */
export function needsHudAttention(agent: HudStateSource): boolean {
  const level = hudStateLevel(agent)
  return level === 'notice' || level === 'action' || level === 'fault'
}

/** Sort priority for choosing one representative from overlapping sessions. */
export function hudStatePriority(agent: HudStateSource): number {
  switch (hudStateLevel(agent)) {
    case 'fault':
      return 4
    case 'action':
      return 3
    case 'notice':
      return 2
    case 'active':
      return 1
    case 'quiet':
      return 0
  }
}

import { TurnState, type AgentRuntimeState, type AgentType } from '@codepulse/shared'

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex']

export function buildDisplayAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  const byType = new Map(agents.map((agent) => [agent.agentType, agent]))
  const primary = DISPLAY_AGENT_ORDER.map(
    (agentType) => byType.get(agentType) ?? idleAgent(agentType),
  )
  const extras = agents.filter((agent) => !DISPLAY_AGENT_ORDER.includes(agent.agentType))
  return [...primary, ...extras]
}

function idleAgent(agentType: AgentType): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    activity: '等待事件',
    lastEventAt: 0,
    unread: false,
  }
}

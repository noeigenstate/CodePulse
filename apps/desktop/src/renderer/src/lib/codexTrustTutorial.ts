import type { Agent, AgentType } from '@codepulse/shared'

export interface AgentSetupReminder {
  missingCli: AgentType[]
  missingHook: AgentType[]
  needsCodexTrust: boolean
}

export function buildAgentSetupReminder(agents: Agent[]): AgentSetupReminder {
  return {
    missingCli: agents.filter((agent) => !agent.installed).map((agent) => agent.type),
    missingHook: agents
      .filter((agent) => agent.installed && !agent.configured)
      .map((agent) => agent.type),
    needsCodexTrust: agents.some(
      (agent) => agent.type === 'codex' && agent.installed && agent.configured,
    ),
  }
}

export function shouldShowAgentSetupReminder(
  reminder: AgentSetupReminder,
  agentCheckId: number,
  dismissedAgentCheckId: number | undefined,
): boolean {
  if (agentCheckId <= 0 || dismissedAgentCheckId === agentCheckId) return false
  return (
    reminder.needsCodexTrust || reminder.missingCli.length > 0 || reminder.missingHook.length > 0
  )
}

export function dismissAgentSetupReminder(agentCheckId: number): number {
  return agentCheckId
}

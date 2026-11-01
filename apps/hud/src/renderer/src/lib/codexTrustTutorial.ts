import type { Agent, AgentType } from '@codepulse/shared'

export const CODEX_TRUST_ACKNOWLEDGED_STORAGE_KEY = 'codepulse:codex-trust-acknowledged'

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

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
  codexTrustAcknowledged = false,
): boolean {
  if (agentCheckId <= 0 || dismissedAgentCheckId === agentCheckId) return false
  if (reminder.missingCli.length > 0 || reminder.missingHook.length > 0) return true
  return reminder.needsCodexTrust && !codexTrustAcknowledged
}

export function dismissAgentSetupReminder(agentCheckId: number): number {
  return agentCheckId
}

export function readCodexTrustAcknowledged(storage: StorageLike | undefined): boolean {
  return storage?.getItem(CODEX_TRUST_ACKNOWLEDGED_STORAGE_KEY) === '1'
}

export function acknowledgeCodexTrust(storage: StorageLike | undefined): boolean {
  storage?.setItem(CODEX_TRUST_ACKNOWLEDGED_STORAGE_KEY, '1')
  return true
}

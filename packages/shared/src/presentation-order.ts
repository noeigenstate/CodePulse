import type { AgentType } from './types/agent.js'

/** HUD presentation order; state and activity do not change a provider's rank. */
export function hudProviderRank(type: AgentType): number {
  switch (type) {
    case 'claude_code': return 0
    case 'codex': return 1
    case 'kimi': return 2
    case 'grok': return 3
    case 'antigravity': return 4
    default: return Number.MAX_SAFE_INTEGER - 1
  }
}

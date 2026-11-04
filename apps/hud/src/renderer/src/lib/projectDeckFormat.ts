import {
  TurnState,
  formatTokenCount,
  formatTokenPercent,
  type AgentRuntimeState,
} from '@codepulse/shared'
import type { ProjectUsageSummary } from './projectDeck.js'
import type { Locale } from './i18n.js'

/** Renders `5小时 23% 周 11%` when both quota windows exist, or a bare percent for one. */
export function formatUsageWindows(item: ProjectUsageSummary, locale: Locale): string {
  const fiveHour =
    item.fiveHourPercent != null
      ? `${locale === 'zh' ? '5小时' : '5h'} ${formatTokenPercent(item.fiveHourPercent)}`
      : undefined
  const sevenDay =
    item.sevenDayPercent != null
      ? `${item.fiveHourPercent != null ? `${locale === 'zh' ? '周' : 'wk'} ` : ''}${formatTokenPercent(item.sevenDayPercent)}`
      : undefined
  return [fiveHour, sevenDay].filter(Boolean).join(' ')
}

/**
 * Compact context readout like `43% (109k/256k)`: used percent plus absolute
 * tokens when the agent reports its context window size.
 */
export function formatContextLabel(agent: AgentRuntimeState, locale: Locale): string | undefined {
  const contextUsed = normalizedPercent(agent.token?.contextUsedPercent)
  if (contextUsed == null) return undefined
  const usedPercent = Math.round(contextUsed)
  const window = agent.token?.contextWindow
  if (window == null || !Number.isFinite(window) || window <= 0) {
    return locale === 'zh' ? `上下文 ${usedPercent}%` : `Context ${usedPercent}%`
  }
  const usedTokens = Math.round((contextUsed / 100) * window)
  return `${usedPercent}% (${formatTokenCount(usedTokens)}/${formatTokenCount(window)})`
}

export function elapsedMs(agent: AgentRuntimeState, now: number): number | undefined {
  if (agent.turnTiming?.state === 'completed' && agent.turnTiming.elapsedMs != null) {
    return Math.max(0, agent.turnTiming.elapsedMs)
  }
  const startedAt = agent.turnTiming?.startedAt ?? agent.turnStartedAt
  if (startedAt != null && isActiveTurn(agent.state)) return Math.max(0, now - startedAt)
  return agent.turnTiming?.elapsedMs
}

function isActiveTurn(state: TurnState): boolean {
  return (
    state === TurnState.PROMPT_SUBMITTED ||
    state === TurnState.THINKING ||
    state === TurnState.TOOL_RUNNING ||
    state === TurnState.WAITING_PERMISSION ||
    state === TurnState.WAITING_USER_INPUT
  )
}

function normalizedPercent(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

import type { AgentType, TokenPayload, TokenRateLimitWindow } from '../work-types.js'

/** Claude Code and Kimi expose both five-hour and weekly quota windows. */
export function showsFiveHourQuota(agentType: AgentType | undefined): boolean {
  return agentType === 'claude_code' || agentType === 'kimi'
}

export function visibleRateLimitWindows(
  token: TokenPayload | undefined,
  agentType?: AgentType,
): {
  fiveHour?: TokenRateLimitWindow
  sevenDay?: TokenRateLimitWindow
} {
  const rateLimits = token?.rateLimits
  if (!rateLimits) return {}

  const includeFiveHour = showsFiveHourQuota(agentType)
  const fiveHour = includeFiveHour ? rateLimits.fiveHour : undefined
  const sevenDay = rateLimits.sevenDay
  const windows = [fiveHour, sevenDay].filter(Boolean)
  if (windows.length === 0) return {}

  const hasDisplayableUsage = windows.some((window) => {
    const pct = normalizedPercent(window?.usedPercent)
    return (
      pct !== undefined &&
      (pct > 0 || window?.resetsAt !== undefined || window?.windowMinutes !== undefined)
    )
  })
  if (!hasDisplayableUsage) return {}

  return {
    ...(fiveHour ? { fiveHour } : {}),
    ...(sevenDay ? { sevenDay } : {}),
  }
}

function normalizedPercent(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

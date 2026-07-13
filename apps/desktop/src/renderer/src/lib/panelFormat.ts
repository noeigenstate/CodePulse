import type { AgentType, TokenPayload, TokenRateLimitWindow } from '@codepulse/shared'
import type { ContextStatusCopy, PathStatusCopy } from './i18n.js'

/** Codex / Grok 仅展示周额度；Claude Code 仍展示 5 小时 + 周额度。 */
export function showsFiveHourQuota(agentType: AgentType | undefined): boolean {
  return agentType === 'claude_code'
}

export interface ContextWindowStatus {
  usedPercent?: number
  text: string
  stale?: boolean
}

export function formatContextWindowStatus(
  token: TokenPayload | undefined,
  fallbackWindow?: number,
  copy: ContextStatusCopy = {
    waiting: 'Waiting for CLI context',
    lastPrefix: 'last: ',
    left: 'left',
    used: 'used',
  },
): ContextWindowStatus {
  const usedPercent = normalizedPercent(token?.contextUsedPercent)
  const contextWindow = positiveNumber(token?.contextWindow ?? fallbackWindow)

  if (usedPercent === undefined || contextWindow === undefined) {
    return { text: copy.waiting }
  }

  const usedTokens = Math.min(contextWindow, (contextWindow * usedPercent) / 100)
  const leftPercent = Math.max(0, Math.ceil(100 - usedPercent))

  return {
    usedPercent,
    stale: token?.contextStale === true,
    text: `${token?.contextStale ? copy.lastPrefix : ''}${leftPercent}% ${copy.left} (${formatContextUsedCount(usedTokens)} ${copy.used} / ${formatContextTotalCount(contextWindow)})`,
  }
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

export function formatWorkspaceLocation(
  path: string | undefined,
  copy: PathStatusCopy = {
    waitingProjectPath: 'Waiting for project path',
    waitingDirectory: 'Waiting for directory',
    projectRoot: 'Project root',
  },
): string {
  if (!path) return copy.waitingProjectPath

  const parts = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)

  if (parts.length === 0) return path
  const tail = parts.slice(-2).join(' / ')
  return parts.length > 2 ? `... / ${tail}` : tail
}

export function formatProjectDirectoryBadge(
  path: string | undefined,
  projectName: string | undefined,
  copy: PathStatusCopy = {
    waitingProjectPath: 'Waiting for project path',
    waitingDirectory: 'Waiting for directory',
    projectRoot: 'Project root',
  },
): string {
  if (!path) return copy.waitingDirectory

  const parts = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)

  if (parts.length === 0) return path

  const name = projectName?.toLowerCase()
  const directoryParts = name && parts.at(-1)?.toLowerCase() === name ? parts.slice(0, -1) : parts

  if (directoryParts.length === 0) return copy.projectRoot

  const tail = directoryParts.slice(-2).join(' / ')
  return directoryParts.length > 2 ? `... / ${tail}` : tail
}

function normalizedPercent(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function positiveNumber(value: number | undefined): number | undefined {
  return value != null && Number.isFinite(value) && value > 0 ? value : undefined
}

function formatContextUsedCount(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(Math.ceil(value / 100_000) / 10)}M`
  if (value >= 1_000) return `${Math.ceil(value / 1000)}K`
  return String(Math.ceil(value))
}

function formatContextTotalCount(value: number): string {
  if (value >= 1_000_000) return `${trimFixed(Math.round(value / 100_000) / 10)}M`
  if (value >= 1_000) return `${Math.round(value / 1000)}K`
  return String(Math.round(value))
}

function trimFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '')
}

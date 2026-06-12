import type { TokenPayload, TokenRateLimitWindow } from '@codepulse/shared'

export interface ContextWindowStatus {
  usedPercent?: number
  text: string
}

export function formatContextWindowStatus(
  token: TokenPayload | undefined,
  fallbackWindow?: number,
): ContextWindowStatus {
  const usedPercent = normalizedPercent(token?.contextUsedPercent)
  const contextWindow = positiveNumber(token?.contextWindow ?? fallbackWindow)

  if (usedPercent === undefined || contextWindow === undefined) {
    return { text: 'waiting for CLI status' }
  }

  const usedTokens = Math.min(contextWindow, (contextWindow * usedPercent) / 100)
  const leftPercent = Math.max(0, Math.ceil(100 - usedPercent))

  return {
    usedPercent,
    text: `${leftPercent}% left (${formatContextUsedCount(usedTokens)} used / ${formatContextTotalCount(contextWindow)})`,
  }
}

export function visibleRateLimitWindows(token: TokenPayload | undefined): {
  fiveHour?: TokenRateLimitWindow
  sevenDay?: TokenRateLimitWindow
} {
  const rateLimits = token?.rateLimits
  if (!rateLimits) return {}

  const windows = [rateLimits.fiveHour, rateLimits.sevenDay].filter(Boolean)
  if (windows.length === 0) return {}

  const hasNonZeroUsage = windows.some((window) => {
    const pct = normalizedPercent(window?.usedPercent)
    return pct !== undefined && pct > 0
  })
  if (!hasNonZeroUsage) return {}

  return rateLimits
}

export function formatWorkspaceLocation(path: string | undefined): string {
  if (!path) return 'waiting for project path'

  const parts = path
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)

  if (parts.length === 0) return path
  const tail = parts.slice(-2).join(' / ')
  return parts.length > 2 ? `... / ${tail}` : tail
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

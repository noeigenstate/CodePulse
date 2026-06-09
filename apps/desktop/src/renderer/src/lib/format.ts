/**
 * Presentation helpers for the renderer: maps states to labels + Tailwind
 * colour classes and formats durations, paths, and relative times.
 *
 * @module renderer/lib/format
 */
import { type OverallState, TurnState } from '@codepulse/shared'

/**
 * A display label paired with the Tailwind classes for its status dot and text.
 */
export interface StateStyle {
  /** Human-readable Chinese label. */
  label: string
  /** Tailwind classes for the coloured status dot. */
  dot: string
  /** Tailwind class for the label text colour. */
  text: string
}

/**
 * Returns the label + colour classes for a per-turn state.
 *
 * @param state The turn state to style.
 * @returns The matching {@link StateStyle}.
 */
export function turnStateStyle(state: TurnState): StateStyle {
  switch (state) {
    case TurnState.IDLE:
      return { label: '空闲', dot: 'bg-gray-400', text: 'text-gray-300' }
    case TurnState.PROMPT_SUBMITTED:
    case TurnState.THINKING:
      return { label: '处理中', dot: 'bg-blue-400 animate-pulse', text: 'text-blue-300' }
    case TurnState.TOOL_RUNNING:
      return { label: '执行工具', dot: 'bg-blue-400 animate-pulse', text: 'text-blue-300' }
    case TurnState.WAITING_PERMISSION:
      return { label: '等待授权', dot: 'bg-yellow-400', text: 'text-yellow-300' }
    case TurnState.WAITING_USER_INPUT:
      return { label: '等待输入', dot: 'bg-yellow-400', text: 'text-yellow-300' }
    case TurnState.DONE:
      return { label: '已完成', dot: 'bg-green-400', text: 'text-green-300' }
    case TurnState.ERROR:
      return { label: '出错', dot: 'bg-red-500', text: 'text-red-300' }
    case TurnState.TIMEOUT:
      return { label: '疑似卡住', dot: 'bg-orange-400', text: 'text-orange-300' }
    case TurnState.CANCELLED:
      return { label: '已取消', dot: 'bg-gray-500', text: 'text-gray-400' }
    default:
      return { label: state, dot: 'bg-gray-400', text: 'text-gray-300' }
  }
}

/**
 * Returns the label + colour classes for the aggregated overall state.
 *
 * @param overall The overall state to style.
 * @returns The matching {@link StateStyle}.
 */
export function overallStyle(overall: OverallState): StateStyle {
  switch (overall) {
    case 'running':
      return { label: '执行中', dot: 'bg-blue-400', text: 'text-blue-300' }
    case 'attention':
      return { label: '需要介入', dot: 'bg-yellow-400', text: 'text-yellow-300' }
    case 'done_unread':
      return { label: '一轮完成', dot: 'bg-green-400', text: 'text-green-300' }
    case 'error':
      return { label: '出错', dot: 'bg-red-500', text: 'text-red-300' }
    case 'stuck':
      return { label: '疑似卡住', dot: 'bg-orange-400', text: 'text-orange-300' }
    default:
      return { label: '空闲', dot: 'bg-gray-400', text: 'text-gray-300' }
  }
}

/**
 * Maps an agent type to its display name.
 *
 * @param type The agent type string.
 * @returns `"Codex"` or `"Claude Code"`.
 */
export function agentName(type: string): string {
  return type === 'codex' ? 'Codex' : 'Claude Code'
}

/**
 * Formats an elapsed duration compactly, e.g. `"3m 12s"` or `"1h 4m"`.
 *
 * @param ms Duration in milliseconds (negative values are clamped to 0).
 * @returns The formatted string.
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Returns the final segment of a path (handles both `/` and `\`).
 *
 * @param path The path, possibly `undefined`.
 * @returns The basename, or `"—"` when no path is given.
 */
export function basename(path: string | undefined): string {
  if (!path) return '—'
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

/**
 * Formats a timestamp relative to now, e.g. `"刚刚"`, `"12s ago"`, `"3m ago"`.
 *
 * @param ts The event time in epoch millis.
 * @param now The current time in epoch millis.
 * @returns A short relative-time string.
 */
export function formatRelative(ts: number, now: number): string {
  const diff = now - ts
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

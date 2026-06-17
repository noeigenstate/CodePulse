/**
 * 渲染端展示辅助函数：把状态映射为标签 + Tailwind 颜色类，
 * 并格式化时长、路径与相对时间。
 *
 * @module renderer/lib/format
 */
import {
  formatTokenCount,
  formatTokenPercent,
  type OverallState,
  TurnState,
} from '@codepulse/shared'
import type { Locale } from './i18n.js'

/**
 * 显示标签及其状态圆点与文字的 Tailwind 类。
 */
export interface StateStyle {
  /** 人类可读的中文标签。 */
  label: string
  /** 彩色状态圆点的 Tailwind 类。 */
  dot: string
  /** 标签文字颜色的 Tailwind 类。 */
  text: string
}

/**
 * 返回某轮次状态的标签 + 颜色类。
 *
 * @param state 要设置样式的轮次状态。
 * @returns 匹配的 {@link StateStyle}。
 */
export function turnStateStyle(state: TurnState): StateStyle {
  switch (state) {
    case TurnState.IDLE:
      return { label: '空闲', dot: 'bg-amber-500', text: 'text-slate-600' }
    case TurnState.PROMPT_SUBMITTED:
    case TurnState.THINKING:
      return { label: '处理中', dot: 'bg-blue-500 animate-pulse', text: 'text-blue-700' }
    case TurnState.TOOL_RUNNING:
      return { label: '执行工具', dot: 'bg-blue-500 animate-pulse', text: 'text-blue-700' }
    case TurnState.WAITING_PERMISSION:
      return { label: '等待授权', dot: 'bg-amber-500', text: 'text-amber-700' }
    case TurnState.WAITING_USER_INPUT:
      return { label: '等待输入', dot: 'bg-amber-500', text: 'text-amber-700' }
    case TurnState.DONE:
      return { label: '已完成', dot: 'bg-emerald-500', text: 'text-emerald-700' }
    case TurnState.ERROR:
      return { label: '出错', dot: 'bg-red-500', text: 'text-red-700' }
    case TurnState.TIMEOUT:
      return { label: '疑似卡住', dot: 'bg-orange-500', text: 'text-orange-700' }
    case TurnState.USAGE_LIMITED:
      return { label: '已达用量上限，任务暂时停止', dot: 'bg-red-500', text: 'text-red-700' }
    case TurnState.CANCELLED:
      return { label: '已取消', dot: 'bg-slate-400', text: 'text-slate-500' }
    default:
      return { label: state, dot: 'bg-slate-400', text: 'text-slate-500' }
  }
}

/**
 * 返回聚合总体状态的标签 + 颜色类。
 *
 * @param overall 要设置样式的总体状态。
 * @returns 匹配的 {@link StateStyle}。
 */
export function overallStyle(overall: OverallState): StateStyle {
  switch (overall) {
    case 'running':
      return { label: '执行中', dot: 'bg-blue-500', text: 'text-blue-700' }
    case 'attention':
      return { label: '需要介入', dot: 'bg-amber-500', text: 'text-amber-700' }
    case 'done_unread':
      return { label: '一轮完成', dot: 'bg-emerald-500', text: 'text-emerald-700' }
    case 'error':
      return { label: '出错', dot: 'bg-red-500', text: 'text-red-700' }
    case 'stuck':
      return { label: '疑似卡住', dot: 'bg-orange-500', text: 'text-orange-700' }
    case 'limited':
      return { label: '用量上限', dot: 'bg-red-500', text: 'text-red-700' }
    default:
      return { label: '空闲', dot: 'bg-amber-500', text: 'text-slate-600' }
  }
}

/**
 * 把 agent 类型映射为显示名称。
 *
 * @param type agent 类型字符串。
 * @returns `"Codex"` 或 `"Claude Code"`。
 */
export function agentName(type: string): string {
  return type === 'codex' ? 'Codex' : 'Claude Code'
}

/**
 * 紧凑格式化已用时长，例如 `"3m 12s"` 或 `"1h 4m"`。
 *
 * @param ms 时长（毫秒，负值按 0 处理）。
 * @returns 格式化后的字符串。
 */
export function formatDuration(ms: number, locale: Locale = 'zh'): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (locale === 'zh') {
    if (h > 0) return `${h} 小时 ${m} 分`
    if (m > 0) return `${m} 分 ${s} 秒`
    return `${s} 秒`
  }
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * 返回路径的最后一段（同时处理 `/` 与 `\`）。
 *
 * @param path 路径，可能为 `undefined`。
 * @returns 最后一段；未提供路径时返回 `"—"`。
 */
export function basename(path: string | undefined): string {
  if (!path) return '—'
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

/**
 * 紧凑格式化 token 数，例如 `512` → `"512"`、`66899` → `"66.9k"`、
 * `1_250_000` → `"1.25M"`。
 *
 * @param n token 数，可能为 `undefined`。
 * @returns 紧凑字符串；无值时返回 `"—"`。
 */
export function formatTokens(n: number | undefined): string {
  return formatTokenCount(n)
}

/**
 * 格式化 token/上下文百分比，例如 `83.4` → `"83%"`。
 *
 * @param pct 百分比，可能为 `undefined`。
 * @returns 格式化后的百分比；无值时返回 `"—"`。
 */
export function formatPercent(pct: number | undefined): string {
  return formatTokenPercent(pct)
}

/**
 * 把时间戳格式化为相对当前的时间，例如 `"刚刚"`、`"12s ago"`、`"3m ago"`。
 *
 * @param ts 事件时间（epoch 毫秒）。
 * @param now 当前时间（epoch 毫秒）。
 * @returns 简短的相对时间字符串。
 */
export function formatRelative(ts: number, now: number, locale: Locale = 'zh'): string {
  const diff = now - ts
  if (locale === 'zh') {
    if (diff < 5_000) return '刚刚'
    if (diff < 60_000) return `${Math.floor(diff / 1000)} 秒前`
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
    return `${Math.floor(diff / 3_600_000)} 小时前`
  }
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

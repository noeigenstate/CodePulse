import type { InkConnection, InkDisplayPlan, InkFeatureId, InkScreenStatus } from '@codepulse/shared'
import type { Locale } from './i18n.js'

/**
 * Pure wording for the e-ink status pill at the bottom of the sidebar. The pill renders whatever
 * this returns, so every state (service off / not connected / connected / temporary) is testable
 * without React.
 */
export type InkPillState = 'server-off' | 'disconnected' | 'connected' | 'temporary'

export interface InkPillText {
  state: InkPillState
  /** Hollow = not connected, filled = connected, ring = a temporary display is on or paused. */
  dot: 'hollow' | 'filled' | 'ring'
  /** Bold lead-in: 「墨水屏」 or 「临时展示」. */
  prefix: string
  /** The rest of the visible line, e.g. 「工作画面 · 14:30 桌边内容」. */
  label: string
  /** Full detail for the title tooltip (also the base of the aria-label). */
  title: string
  /** Tooltip carried by an ⓘ mark, only when the pill needs one (service off). */
  info: string
  /** The ✕ ends a temporary display. */
  canEnd: boolean
}

const FEATURE_NAMES: Record<InkFeatureId, [string, string]> = {
  work: ['工作画面', 'Work screen'],
  ambient: ['桌边内容', 'Desk content'],
  todos: ['待办与提醒', 'Tasks & reminders'],
}
/** Short names for the one-line pill. */
const SHORT_NAMES: Record<InkFeatureId, [string, string]> = {
  work: ['工作画面', 'Work'],
  ambient: ['桌边内容', 'Desk'],
  todos: ['待办', 'Tasks'],
}

export function inkFeatureName(feature: InkFeatureId, locale: Locale): string {
  return FEATURE_NAMES[feature][locale === 'zh' ? 0 : 1]
}

/** HH:mm in local time. */
export function clockText(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function minutesLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 60000))
}

/** What the screen is showing now, e.g. 「正在显示：桌边内容 · 机会成本」. */
export function showingText(status: InkScreenStatus, locale: Locale): string {
  const zh = locale === 'zh'
  const { showing } = status
  if (showing.kind === 'work') return zh ? '正在显示：工作画面' : 'Showing: work screen'
  if (showing.kind === 'todos') return zh ? '正在显示：待办' : 'Showing: tasks'
  const title = showing.title.trim()
  const label = zh ? '桌边内容' : 'Desk content'
  return `${zh ? '正在显示：' : 'Showing: '}${title ? `${label} · ${title}` : label}`
}

const SERVER_HINT = 'CODEPULSE_DEVICE_SERVER_ENABLED=1'

export function inkPillText(status: InkScreenStatus, now: number, locale: Locale): InkPillText {
  const zh = locale === 'zh'
  const prefix = zh ? '墨水屏' : 'E-paper'
  const note = status.slotNote.trim()
  const withNote = (text: string) => (note ? `${text} · ${note}` : text)
  const short = (feature: InkFeatureId) => SHORT_NAMES[feature][zh ? 0 : 1]
  if (status.connection === 'server-off') {
    const info = zh ? `启动时设置 ${SERVER_HINT}` : `Start with ${SERVER_HINT}`
    const label = zh ? '服务未开启' : 'service off'
    return { state: 'server-off', dot: 'hollow', prefix, label, title: `${prefix} ${label} · ${info}`, info, canEnd: false }
  }
  const temporary = status.temporary
  if (temporary) {
    const left = minutesLeft(temporary.until, now)
    // A temporary display that an alert hides still counts down: `showing` is the work screen then.
    const paused = status.showing.kind === 'work'
    const name = temporary.title.trim() || (temporary.kind === 'todos' ? short('todos') : short('ambient'))
    const lead = zh ? '临时展示' : 'Temporary'
    const left_ = zh ? `剩 ${left} 分钟` : `${left} min left`
    const label = paused ? (zh ? `已暂停 · ${left_}` : `paused · ${left_}`) : left_
    return {
      state: 'temporary', dot: 'ring', prefix: lead, label,
      title: withNote(`${lead}：${name} · ${label}`), info: '', canEnd: true,
    }
  }
  if (status.connection === 'disconnected') {
    const label = zh ? '未连接' : 'not connected'
    return { state: 'disconnected', dot: 'hollow', prefix, label, title: `${prefix} ${label}`, info: '', canEnd: false }
  }
  const current = short(status.showing.kind === 'work' ? 'work' : status.showing.kind)
  let label: string
  let detail = showingText(status, locale)
  if (status.next) {
    const left = minutesLeft(status.next.at, now)
    label = `${current} · ${clockText(status.next.at)} ${short(status.next.feature)}`
    detail += zh
      ? ` · 下一项：${inkFeatureName(status.next.feature, locale)} ${clockText(status.next.at)}（${left} 分钟后）`
      : ` · Next: ${inkFeatureName(status.next.feature, locale)} ${clockText(status.next.at)} (in ${left} min)`
  } else if (status.mode === 'single') {
    label = zh ? '固定 · 工作画面' : 'Fixed · Work'
    detail += zh ? ' · 固定显示工作画面' : ' · Fixed on the work screen'
  } else {
    label = zh ? '仅工作画面' : 'Work only'
    detail += zh ? ' · 节目单里只有工作画面' : ' · The playlist has only the work screen'
  }
  return { state: 'connected', dot: 'filled', prefix, label, title: withNote(`${prefix} ${label} · ${detail}`), info: '', canEnd: false }
}

/**
 * Read-only chip on the 桌边内容 page: is desk content in the applied playlist? Built from the
 * applied plan (never a draft); when no device is connected the playlist takes effect on connect.
 */
export function inkPlanChip(
  plan: InkDisplayPlan,
  feature: Exclude<InkFeatureId, 'work'>,
  connection: InkConnection | undefined,
  locale: Locale,
): { text: string; included: boolean } {
  const zh = locale === 'zh'
  const later = connection === 'connected' ? '' : zh ? '（连接后生效）' : ' (applies once connected)'
  if (plan.mode === 'single') {
    return { included: false, text: (zh ? '只显示工作画面' : 'Work screen only') + later }
  }
  if (!plan.items.includes(feature)) return { included: false, text: zh ? '未加入节目单' : 'Not in the playlist' }
  return {
    included: true,
    text: (zh ? `轮播中 · 每 ${plan.intervalMinutes} 分钟` : `Rotating · every ${plan.intervalMinutes} min`) + later,
  }
}

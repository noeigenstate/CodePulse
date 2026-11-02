import type { InkConnection, InkDisplayPlan, InkFeatureId, InkScreenStatus } from '@codepulse/shared'
import type { Locale } from './i18n.js'

/**
 * Pure wording for the global e-ink status bar. The bar renders whatever this returns, so the
 * four states (service off / not connected / connected / temporary) are testable without React.
 */
export type InkBarState = 'server-off' | 'disconnected' | 'connected' | 'temporary'
/** `connect` opens 控制 › 墨水屏, `playlist` opens the playlist, `end-temporary` returns to the work screen. */
export type InkBarAction = 'connect' | 'playlist' | 'end-temporary'

export interface InkBarText {
  state: InkBarState
  /** Hollow = not connected, filled = connected, ring = a temporary display is on or paused. */
  dot: 'hollow' | 'filled' | 'ring'
  headline: string
  /** Muted detail messages shown after the headline; the first one is emphasised when `emphasis` is set. */
  messages: string[]
  emphasis: boolean
  /** One extra muted line (the slot note), or ''. */
  note: string
  action: InkBarAction | null
  actionLabel: string
}

const FEATURE_NAMES: Record<InkFeatureId, [string, string]> = {
  work: ['工作画面', 'Work screen'],
  ambient: ['桌边内容', 'Desk content'],
  todos: ['待办与提醒', 'Tasks & reminders'],
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

export function inkStatusText(status: InkScreenStatus, now: number, locale: Locale): InkBarText {
  const zh = locale === 'zh'
  const prefix = zh ? '墨水屏' : 'E-paper'
  const note = status.slotNote.trim()
  const base = { emphasis: false, note, action: null as InkBarAction | null, actionLabel: '' }
  if (status.connection === 'server-off') {
    return {
      ...base, state: 'server-off', dot: 'hollow', note: '',
      headline: zh ? `${prefix} · 设备服务未开启` : `${prefix} · device service is off`,
      messages: [zh ? '启动时设置 CODEPULSE_DEVICE_SERVER_ENABLED=1' : 'Start with CODEPULSE_DEVICE_SERVER_ENABLED=1'],
    }
  }
  const temporary = status.temporary
  if (temporary) {
    const left = minutesLeft(temporary.until, now)
    // A temporary display that an alert hides still counts down: `showing` is the work screen then.
    const paused = status.showing.kind === 'work'
    const title = temporary.title.trim() || (temporary.kind === 'todos' ? (zh ? '待办' : 'Tasks') : (zh ? '桌边内容' : 'Desk content'))
    return {
      ...base, state: 'temporary', dot: 'ring',
      headline: paused
        ? (zh ? `临时展示已暂停：${title}` : `Temporary display paused: ${title}`)
        : (zh ? `正在临时展示：${title}` : `Temporary display: ${title}`),
      messages: [zh ? `剩 ${left} 分钟` : `${left} min left`],
      action: 'end-temporary', actionLabel: zh ? '回到工作画面' : 'Back to work screen',
    }
  }
  if (status.connection === 'disconnected') {
    return {
      ...base, state: 'disconnected', dot: 'hollow', note: '',
      headline: zh ? `${prefix} · 未连接` : `${prefix} · not connected`,
      messages: [zh ? '可先用预览配置，连接后自动同步' : 'You can configure the preview now; it syncs once a device connects'],
      action: 'connect', actionLabel: zh ? '连接设备' : 'Connect device',
    }
  }
  const messages = [showingText(status, locale)]
  if (status.next) {
    const left = minutesLeft(status.next.at, now)
    messages.push(zh
      ? `下一项：${inkFeatureName(status.next.feature, locale)} · ${clockText(status.next.at)}（${left} 分钟后）`
      : `Next: ${inkFeatureName(status.next.feature, locale)} · ${clockText(status.next.at)} (in ${left} min)`)
  } else if (status.mode === 'single') {
    messages.push(zh ? '固定显示：工作画面' : 'Fixed: work screen')
  } else {
    messages.push(zh ? '仅工作画面' : 'Work screen only')
  }
  return {
    ...base, state: 'connected', dot: 'filled', emphasis: true,
    headline: zh ? `${prefix} · 已连接` : `${prefix} · connected`,
    messages,
    action: 'playlist', actionLabel: zh ? '节目单' : 'Playlist',
  }
}

/**
 * Read-only note on 桌边内容 / 待办 pages: is this feature in the applied playlist? Built from the
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
    return { included: false, text: (zh ? '固定显示工作画面时不出现' : 'Not shown while the work screen is fixed') + later }
  }
  if (!plan.items.includes(feature)) return { included: false, text: zh ? '未加入节目单' : 'Not in the playlist' }
  return {
    included: true,
    text: (zh ? `已在节目单中 · 每项 ${plan.intervalMinutes} 分钟` : `In the playlist · ${plan.intervalMinutes} min each`) + later,
  }
}

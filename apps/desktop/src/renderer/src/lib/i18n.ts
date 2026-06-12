import type { OverallState } from '@codepulse/shared'
import { TurnState } from '@codepulse/shared'

export type Locale = 'zh' | 'en'

export interface HeaderCopy {
  brandTag: string
  subtitle: string
  clearAlerts: string
  mute: string
  muted: string
  languageToggle: string
}

export interface UiCopy {
  project: string
  recent: string
  model: string
  elapsed: string
  fiveHourQuota: string
  weeklyQuota: string
  waitingQuota: string
  read: string
  contextWindow: string
}

interface LocaleStorageLike {
  getItem(key: string): string | null
}

const HEADER_COPY: Record<Locale, HeaderCopy> = {
  zh: {
    brandTag: '',
    subtitle: 'AI coding-agent live console',
    clearAlerts: '清除提醒',
    mute: '静音 30 分钟',
    muted: '已静音',
    languageToggle: 'EN',
  },
  en: {
    brandTag: '',
    subtitle: 'AI coding-agent live console',
    clearAlerts: 'Clear alerts',
    mute: 'Mute 30 min',
    muted: 'Muted',
    languageToggle: '中',
  },
}

const UI_COPY: Record<Locale, UiCopy> = {
  zh: {
    project: '项目',
    recent: '最近',
    model: '模型',
    elapsed: '耗时',
    fiveHourQuota: '5 小时额度',
    weeklyQuota: '每周额度',
    waitingQuota: '等待 CLI 同步额度',
    read: '已读',
    contextWindow: 'Context window:',
  },
  en: {
    project: 'Projects',
    recent: 'Recent',
    model: 'Model',
    elapsed: 'Elapsed',
    fiveHourQuota: '5h quota',
    weeklyQuota: 'Weekly quota',
    waitingQuota: 'Waiting for CLI quota sync',
    read: 'Read',
    contextWindow: 'Context window:',
  },
}

const OVERALL_LABELS: Record<Locale, Record<OverallState, string>> = {
  zh: {
    idle: '空闲',
    running: '执行中',
    attention: '需要介入',
    done_unread: '一轮完成',
    error: '出错',
    stuck: '疑似卡住',
  },
  en: {
    idle: 'Idle',
    running: 'Running',
    attention: 'Attention',
    done_unread: 'Completed',
    error: 'Error',
    stuck: 'Possibly stuck',
  },
}

const TURN_STATE_LABELS: Record<Locale, Record<TurnState, string>> = {
  zh: {
    [TurnState.IDLE]: '空闲',
    [TurnState.PROMPT_SUBMITTED]: '处理中',
    [TurnState.THINKING]: '处理中',
    [TurnState.TOOL_RUNNING]: '执行工具',
    [TurnState.WAITING_PERMISSION]: '等待授权',
    [TurnState.WAITING_USER_INPUT]: '等待输入',
    [TurnState.DONE]: '已完成',
    [TurnState.ERROR]: '出错',
    [TurnState.TIMEOUT]: '疑似卡住',
    [TurnState.CANCELLED]: '已取消',
  },
  en: {
    [TurnState.IDLE]: 'Idle',
    [TurnState.PROMPT_SUBMITTED]: 'Processing',
    [TurnState.THINKING]: 'Processing',
    [TurnState.TOOL_RUNNING]: 'Using tools',
    [TurnState.WAITING_PERMISSION]: 'Permission',
    [TurnState.WAITING_USER_INPUT]: 'Waiting input',
    [TurnState.DONE]: 'Done',
    [TurnState.ERROR]: 'Error',
    [TurnState.TIMEOUT]: 'Possibly stuck',
    [TurnState.CANCELLED]: 'Cancelled',
  },
}

export function nextLocale(locale: Locale): Locale {
  return locale === 'zh' ? 'en' : 'zh'
}

export function headerCopy(locale: Locale): HeaderCopy {
  return HEADER_COPY[locale]
}

export function uiCopy(locale: Locale): UiCopy {
  return UI_COPY[locale]
}

export function overallLabel(overall: OverallState, locale: Locale): string {
  return OVERALL_LABELS[locale][overall]
}

export function turnStateLabel(state: TurnState, locale: Locale): string {
  return TURN_STATE_LABELS[locale][state] ?? state
}

export function readStoredLocale(storage: LocaleStorageLike | undefined): Locale {
  const value = storage?.getItem('codepulse:locale')
  return value === 'en' ? 'en' : 'zh'
}

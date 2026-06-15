import type { OverallState } from '@codepulse/shared'
import { TurnState } from '@codepulse/shared'

export type Locale = 'zh' | 'en'

export interface HeaderCopy {
  brandTag: string
  subtitle: string
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
  unknownProject: string
  agentSetupReminder: AgentSetupReminderCopy
  codexTrustTutorial: CodexTrustTutorialCopy
  contextStatus: ContextStatusCopy
  pathStatus: PathStatusCopy
}

export interface AgentSetupReminderCopy {
  title: string
  body: string
  missingCli: string
  missingHook: string
}

export interface CodexTrustTutorialCopy {
  title: string
  body: string
  steps: string[]
  warning: string
  action: string
}

export interface ContextStatusCopy {
  waiting: string
  lastPrefix: string
  left: string
  used: string
}

export interface PathStatusCopy {
  waitingProjectPath: string
  waitingDirectory: string
  projectRoot: string
}

interface LocaleStorageLike {
  getItem(key: string): string | null
}

const HEADER_COPY: Record<Locale, HeaderCopy> = {
  zh: {
    brandTag: '',
    subtitle: '编程助手实时控制台',
    mute: '静音 30 分钟',
    muted: '已静音',
    languageToggle: '英文',
  },
  en: {
    brandTag: '',
    subtitle: 'AI coding-agent live console',
    mute: 'Mute 30 min',
    muted: 'Muted',
    languageToggle: 'Chinese',
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
    waitingQuota: '等待命令行同步额度',
    read: '已读',
    contextWindow: '上下文窗口：',
    unknownProject: '未识别项目',
    agentSetupReminder: {
      title: '配置与权限检查',
      body: 'CodePulse 每次打开都会检查本机 Claude / Codex 配置。请先处理下面的问题，否则任务状态可能无法同步。',
      missingCli: '未检测到命令行工具',
      missingHook: '未完成 CodePulse 钩子配置',
    },
    codexTrustTutorial: {
      title: '信任 Codex 钩子',
      body: 'CodePulse 已经写入 Codex 钩子配置。Codex 第一次运行该命令前需要你手动信任，否则 CodePulse 无法接收 Codex 任务状态。',
      steps: ['打开任意 Codex 项目终端。', '输入 /hooks。', '选择 CodePulse 钩子并确认信任。'],
      warning: '完成信任后，再运行一轮 Codex 任务，面板就会开始同步。',
      action: '我已在 Codex 信任',
    },
    contextStatus: {
      waiting: '等待命令行同步上下文',
      lastPrefix: '上次：',
      left: '剩余',
      used: '已用',
    },
    pathStatus: {
      waitingProjectPath: '等待项目路径',
      waitingDirectory: '等待目录',
      projectRoot: '项目根目录',
    },
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
    unknownProject: 'Unknown project',
    agentSetupReminder: {
      title: 'Setup and permission check',
      body: 'CodePulse checks local Claude / Codex setup every time it opens. Resolve these items first or task status may not sync.',
      missingCli: 'CLI not detected',
      missingHook: 'CodePulse hook is not configured',
    },
    codexTrustTutorial: {
      title: 'Trust the Codex hook',
      body: 'CodePulse has written the Codex hook configuration. Codex requires you to trust that command before it can run; otherwise CodePulse cannot receive Codex task status.',
      steps: [
        'Open any Codex project terminal.',
        'Type /hooks.',
        'Select the CodePulse hook and trust it.',
      ],
      warning: 'After trusting it, run one Codex task and this panel will start syncing.',
      action: 'I trusted it in Codex',
    },
    contextStatus: {
      waiting: 'Waiting for CLI context',
      lastPrefix: 'last: ',
      left: 'left',
      used: 'used',
    },
    pathStatus: {
      waitingProjectPath: 'Waiting for project path',
      waitingDirectory: 'Waiting for directory',
      projectRoot: 'Project root',
    },
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

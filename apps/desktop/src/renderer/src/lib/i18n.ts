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
  emptyDashboard: EmptyDashboardCopy
  agentSetupReminder: AgentSetupReminderCopy
  codexTrustTutorial: CodexTrustTutorialCopy
  updateAvailable: UpdateAvailableCopy
  contextStatus: ContextStatusCopy
  pathStatus: PathStatusCopy
}

export interface EmptyDashboardCopy {
  title: string
  body: string
}

export interface AgentSetupReminderCopy {
  title: string
  body: string
  firstRunNotice: string
  cleanupNotice: string
  missingCli: string
  missingHook: string
}

export interface CodexTrustTutorialCopy {
  title: string
  body: string
  permissionsTitle: string
  permissions: string[]
  steps: string[]
  warning: string
  action: string
}

export interface UpdateAvailableCopy {
  title: string
  body: string
  manualBody: string
  currentVersion: string
  latestVersion: string
  later: string
  install: string
  openRelease: string
  installing: string
  downloadingPercent: string
  downloadingHint: string
  /** Dual progress: download step label */
  stepDownload: string
  /** Dual progress: install step label */
  stepInstall: string
  phasePreparing: string
  phaseDownloading: string
  phaseVerifying: string
  phaseLaunching: string
  installWaiting: string
  installReady: string
  failed: string
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
    emptyDashboard: {
      title: '等待 CLI 任务',
      body: '开始 Claude Code、Codex 或 Grok 任务后，对应分屏会自动出现；只用一个 CLI 时只显示一栏。',
    },
    agentSetupReminder: {
      title: '配置与权限检查',
      body: 'CodePulse 每次打开都会检查本机 Claude / Codex / Grok 配置。请先处理下面的问题，否则任务状态可能无法同步。',
      firstRunNotice:
        '首次打开时，CodePulse 会在 ~/.claude/settings.json、~/.codex/hooks.json、~/.codex/config.toml 和 ~/.grok/hooks/codepulse.json 写入必要的 CodePulse hook 配置。',
      cleanupNotice:
        '卸载 CodePulse 时，安装器会自动删除这些 CodePulse hook 和 statusLine 配置；用户原有的其它 hook、模型、插件和偏好设置会保留。',
      missingCli: '未检测到命令行工具',
      missingHook: '未完成 CodePulse 钩子配置',
    },
    codexTrustTutorial: {
      title: '信任 Codex 钩子',
      body: 'CodePulse 已经写入 Codex 钩子配置。Codex 第一次运行该命令前需要你手动信任，否则 CodePulse 无法接收 Codex 任务状态。',
      permissionsTitle: '在 /hooks 中需要信任的 CodePulse 权限',
      permissions: [
        'SessionStart：识别 Codex 会话开始和项目目录。',
        'UserPromptSubmit：识别一轮任务已经提交。',
        'PreToolUse / PermissionRequest / PostToolUse：识别工具执行、权限等待和工具完成状态。',
        'Stop：识别当前项目的一轮 Codex 任务已完成并发送桌面提醒。',
      ],
      steps: [
        '打开正在使用的 Codex 项目终端。',
        '输入 /hooks 并回车。',
        '在 /hooks 列表中选择 CodePulse hook。',
        '依次信任 SessionStart、UserPromptSubmit、PreToolUse、PermissionRequest、PostToolUse、Stop 这些事件。',
      ],
      warning: '完成信任后，再运行一轮 Codex 任务，面板就会开始同步。',
      action: '我已在 Codex 信任',
    },
    updateAvailable: {
      title: '发现新版本',
      body: 'CodePulse 已发布新版本。点击立即更新会下载安装包（约 70MB），下载完成后会打开安装器并退出当前应用。过程可能需要几分钟，请保持网络畅通。',
      manualBody:
        'CodePulse 已发布新版本，但当前 Release 没有匹配的 Windows 安装包。你可以先打开发布页查看更新。',
      currentVersion: '当前版本',
      latestVersion: '最新版本',
      later: '稍后',
      install: '立即更新',
      openRelease: '打开发布页',
      installing: '正在更新...',
      downloadingPercent: '下载中 {percent}%',
      downloadingHint: '正在下载安装包，请保持网络畅通',
      stepDownload: '1. 下载安装包',
      stepInstall: '2. 启动安装',
      phasePreparing: '准备下载…',
      phaseDownloading: '正在下载…',
      phaseVerifying: '正在校验安装包…',
      phaseLaunching: '正在打开安装器…',
      installWaiting: '等待下载完成',
      installReady: '即将退出并安装',
      failed: '更新失败，请稍后重试。',
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
    emptyDashboard: {
      title: 'Waiting for CLI tasks',
      body: 'Panels appear when you start Claude Code, Codex, or Grok tasks. If you only use one CLI, only that panel is shown.',
    },
    agentSetupReminder: {
      title: 'Setup and permission check',
      body: 'CodePulse checks local Claude / Codex / Grok setup every time it opens. Resolve these items first or task status may not sync.',
      firstRunNotice:
        'On first launch, CodePulse writes the required CodePulse hook configuration to ~/.claude/settings.json, ~/.codex/hooks.json, ~/.codex/config.toml, and ~/.grok/hooks/codepulse.json.',
      cleanupNotice:
        'When CodePulse is uninstalled, the installer removes those CodePulse hooks and statusLine entries automatically. Your other hooks, models, plugins, and preferences are preserved.',
      missingCli: 'CLI not detected',
      missingHook: 'CodePulse hook is not configured',
    },
    codexTrustTutorial: {
      title: 'Trust the Codex hook',
      body: 'CodePulse has written the Codex hook configuration. Codex requires you to trust that command before it can run; otherwise CodePulse cannot receive Codex task status.',
      permissionsTitle: 'CodePulse permissions to trust in /hooks',
      permissions: [
        'SessionStart: detect Codex session start and project directory.',
        'UserPromptSubmit: detect that a new turn was submitted.',
        'PreToolUse / PermissionRequest / PostToolUse: detect tool execution, permission waits, and tool completion.',
        'Stop: detect that one Codex turn completed for the current project and send a desktop notification.',
      ],
      steps: [
        'Open the Codex project terminal you are using.',
        'Type /hooks.',
        'Select the CodePulse hook in the /hooks list.',
        'Trust SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse, and Stop.',
      ],
      warning: 'After trusting it, run one Codex task and this panel will start syncing.',
      action: 'I trusted it in Codex',
    },
    updateAvailable: {
      title: 'Update available',
      body: 'A new CodePulse version is available. Update now downloads the installer (~70MB), opens it, and quits this app. This may take a few minutes — keep your network connected.',
      manualBody:
        'A new CodePulse version is available, but this release has no matching Windows installer. Open the release page to review it.',
      currentVersion: 'Current',
      latestVersion: 'Latest',
      later: 'Later',
      install: 'Update now',
      openRelease: 'Open release',
      installing: 'Updating...',
      downloadingPercent: 'Downloading {percent}%',
      downloadingHint: 'Downloading the installer — keep your network connected',
      stepDownload: '1. Download installer',
      stepInstall: '2. Start installer',
      phasePreparing: 'Preparing download…',
      phaseDownloading: 'Downloading…',
      phaseVerifying: 'Verifying installer…',
      phaseLaunching: 'Opening installer…',
      installWaiting: 'Waiting for download',
      installReady: 'Quitting to install',
      failed: 'Update failed. Please try again later.',
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
    limited: '用量上限',
  },
  en: {
    idle: 'Idle',
    running: 'Running',
    attention: 'Attention',
    done_unread: 'Completed',
    error: 'Error',
    stuck: 'Possibly stuck',
    limited: 'Usage limit',
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
    [TurnState.USAGE_LIMITED]: '已达用量上限，任务暂时停止',
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
    [TurnState.USAGE_LIMITED]: 'Usage limit reached, paused',
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

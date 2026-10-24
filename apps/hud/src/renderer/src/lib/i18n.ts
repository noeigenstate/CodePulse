import type { OverallState } from '@codepulse/shared'
import { TurnState } from '@codepulse/shared'

export type Locale = 'zh' | 'en'

export interface HeaderCopy {
  brandTag: string
  subtitle: string
  mute: string
  muted: string
  languageToggle: string
  settings: string
}

export interface UiCopy {
  project: string
  recent: string
  model: string
  thinkingDepth: string
  elapsed: string
  fiveHourQuota: string
  weeklyQuota: string
  waitingQuota: string
  read: string
  readAll: string
  complete: string
  dismissProjectCard: string
  attentionRailTitle: string
  attentionRailHint: string
  contextWindow: string
  unknownProject: string
  emptyDashboard: EmptyDashboardCopy
  agentSetupReminder: AgentSetupReminderCopy
  codexTrustTutorial: CodexTrustTutorialCopy
  updateAvailable: UpdateAvailableCopy
  contextStatus: ContextStatusCopy
  pathStatus: PathStatusCopy
  settings: SettingsCopy
}

/**
 * Localized labels for display-only dashboard preferences.
 *
 * `cliToolsHint` must make clear that hiding a panel never stops local sync or notifications.
 */
export interface SettingsCopy {
  title: string
  close: string
  hudAppearance: string
  hudOpacity: string
  hudOpacityHint: string
  attentionEffect: string
  attentionEffectHint: string
  attentionSteady: string
  attentionBreathe: string
  attentionPulse: string
  projectLayout: string
  projectLayoutHint: string
  projectLayoutGrid: string
  projectLayoutList: string
  usageStrip: string
  usageStripHint: string
  resultRetention: string
  resultRetentionHint: string
  /** Labelled duration choices; minutes values must match the settings schema. */
  resultRetentionOptions: readonly { minutes: number; label: string }[]
  theme: string
  themeAuto: string
  themeAutoHint: string
  themeLight: string
  themeDark: string
  cliTools: string
  cliToolsHint: string
  codex: string
  claudeCode: string
  grok: string
  kimi: string
  deviceProvisioning: DeviceProvisioningCopy
}

export interface DeviceProvisioningCopy {
  title: string
  description: string
  scan: string
  scanning: string
  unavailable: string
  serverUnavailable: string
  serverReady: string
  connectHint: string
  noDevice: string
  wifiSsid: string
  wifiPassword: string
  passwordHint: string
  fallbackHost: string
  configuredNetwork: string
  sending: string
  applying: string
  desktopUnreachable: string
  wifiError: string
  ready: string
  cancelled: string
  timeout: string
  invalidInput: string
  deviceMismatch: string
  failed: string
  lanVerified: string
  lanWaiting: string
  cancel: string
  provisioning: string
  provision: string
  securityNote: string
}

/** Localized content for an idle dashboard and the intentional all-tools-hidden state. */
export interface EmptyDashboardCopy {
  title: string
  body: string
  /** Title shown inside a CLI panel that currently has no visible sessions. */
  agentTitle: string
  /** Agent-specific idle message. `{agent}` is replaced with the CLI display name. */
  agentBody: string
  /** Title used when user preferences intentionally hide every CLI panel. */
  settingsHiddenTitle: string
  /** Recovery guidance for the all-tools-hidden state. */
  settingsHiddenBody: string
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
  /** Section title for release notes on the update dialog */
  whatsNew: string
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
  /** Shown when context occupancy dropped sharply (CLI compact/compress). */
  compressedPrefix: string
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
    subtitle: 'AI 编程副驾 HUD',
    mute: '安静 30 分钟',
    muted: '安静中',
    languageToggle: '英文',
    settings: '设置',
  },
  en: {
    brandTag: '',
    subtitle: 'AI coding companion HUD',
    mute: 'Quiet 30 min',
    muted: 'Quiet mode',
    languageToggle: 'Chinese',
    settings: 'Settings',
  },
}

const UI_COPY: Record<Locale, UiCopy> = {
  zh: {
    project: '项目',
    recent: '最近',
    model: '模型',
    thinkingDepth: '思考深度',
    elapsed: '耗时',
    fiveHourQuota: '5 小时额度',
    weeklyQuota: '每周额度',
    waitingQuota: '等待命令行同步额度',
    read: '已读',
    readAll: '全部已读',
    complete: '完成',
    dismissProjectCard: '暂时关闭项目卡片',
    attentionRailTitle: '需要查看',
    attentionRailHint: '橙色项目不会被布局或隐藏偏好遮住',
    contextWindow: '上下文窗口：',
    unknownProject: '未识别项目',
    emptyDashboard: {
      title: '等待 CLI 任务',
      body: '开始 Claude Code、Codex、Grok 或 Kimi 任务后，对应分屏会自动出现；只用一个 CLI 时只显示一栏。',
      agentTitle: '当前没有运行中的会话',
      agentBody: '{agent} 暂无活动，随时准备为你服务',
      settingsHiddenTitle: '所有 CLI 工具已隐藏',
      settingsHiddenBody: '打开右上角设置，重新选择要显示的 CLI 工具。',
    },
    agentSetupReminder: {
      title: '配置与权限检查',
      body: 'CodePulse HUD 每次打开都会检查本机 Claude / Codex / Grok / Kimi 配置。请先处理下面的问题，否则任务状态可能无法同步。',
      firstRunNotice:
        '首次打开时，CodePulse HUD 会在 ~/.claude/settings.json、~/.codex/hooks.json、~/.codex/config.toml、~/.grok/hooks/codepulse.json 和 ~/.kimi-code/config.toml 写入必要的 CodePulse hook 配置。',
      cleanupNotice:
        '卸载 CodePulse HUD 时，安装器会自动删除这些 CodePulse hook 和 statusLine 配置；用户原有的其它 hook、模型、插件和偏好设置会保留。',
      missingCli: '未检测到命令行工具',
      missingHook: '未完成 CodePulse 钩子配置',
    },
    codexTrustTutorial: {
      title: '信任 Codex 钩子',
      body: 'CodePulse HUD 已经写入 Codex 钩子配置。Codex 第一次运行该命令前需要你手动信任，否则 HUD 无法接收 Codex 任务状态。',
      permissionsTitle: '在 /hooks 中需要信任的 CodePulse 权限',
      permissions: [
        'SessionStart：识别 Codex 会话开始和项目目录。',
        'UserPromptSubmit：识别一轮任务已经提交。',
        'PreToolUse / PermissionRequest / PostToolUse：识别工具执行、权限等待和工具完成状态。',
        'Stop：识别当前项目的一轮 Codex 任务已完成，并在 HUD 中标为橙色待确认。',
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
      body: 'CodePulse HUD 已发布新版本。点击立即更新会下载安装包（约 70MB），下载完成后会打开安装器并退出当前应用。过程可能需要几分钟，请保持网络畅通。',
      manualBody:
        'CodePulse HUD 已发布新版本，但当前 Release 没有匹配的 Windows 安装包。你可以先打开发布页查看更新。',
      currentVersion: '当前版本',
      latestVersion: '最新版本',
      whatsNew: '更新内容',
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
      compressedPrefix: '已压缩：',
      left: '剩余',
      used: '已用',
    },
    pathStatus: {
      waitingProjectPath: '等待项目路径',
      waitingDirectory: '等待目录',
      projectRoot: '项目根目录',
    },
    settings: {
      title: '设置',
      close: '关闭设置',
      hudAppearance: 'HUD 外观',
      hudOpacity: '背景透明度',
      hudOpacityHint: '只改变面板背景；文字、图标和控件始终保持完整清晰度。',
      attentionEffect: '橙色提示动效',
      attentionEffectHint: '橙色只表示需要你介入；系统“减少动态效果”会自动关闭动画。',
      attentionSteady: '静态',
      attentionBreathe: '呼吸',
      attentionPulse: '闪烁',
      projectLayout: '项目布局',
      projectLayoutHint: '默认使用单列堆叠，窗口随项目数量收缩；需要并排浏览时可切换矩阵。',
      projectLayoutGrid: '紧凑矩阵',
      projectLayoutList: '单列排序',
      usageStrip: '显示底部用量行',
      usageStripHint: '保留 CLI 配额摘要，但不重新建立 Claude、Codex 或 Grok 分区。',
      resultRetention: '项目卡片停留时长',
      resultRetentionHint: '空闲、已取消或已读结果卡片在 HUD 中继续停留的时长。',
      resultRetentionOptions: [
        { minutes: 10, label: '10 分钟' },
        { minutes: 30, label: '30 分钟' },
        { minutes: 60, label: '1 小时' },
        { minutes: 120, label: '2 小时' },
        { minutes: 240, label: '4 小时' },
      ],
      theme: '主题',
      themeAuto: '自动',
      themeAutoHint: '自动：08:00–20:00 白色，20:00–08:00 黑色。',
      themeLight: '白色',
      themeDark: '黑色',
      cliTools: '显示的 CLI 工具',
      cliToolsHint: '隐藏仅影响 HUD 显示，不会停止本机同步或状态提示。',
      codex: 'Codex',
      claudeCode: 'Claude Code',
      grok: 'Grok',
      kimi: 'Kimi Code',
      deviceProvisioning: {
        title: 'CodePulse 水墨屏',
        description: '通过 USB 自动识别设备并写入 Wi-Fi。请正常长按功能键 3 秒开机，不要按 BOOT。',
        scan: '重新扫描',
        scanning: '扫描中…',
        unavailable: '当前版本的主进程不支持设备配网，请重启或更新 CodePulse。',
        serverUnavailable:
          '设备 API 尚未启动。开发模式请使用 CODEPULSE_DEVICE_SERVER_ENABLED=1 pnpm dev。',
        serverReady: '设备 API 已就绪，后备地址：{host}:17889',
        connectHint: '正在查找 USB 水墨屏，请连接设备并正常开机。',
        noDevice: '尚未发现 CodePulse USB 设备，连接后点击重新扫描。',
        wifiSsid: 'Wi-Fi 名称（SSID）',
        wifiPassword: 'Wi-Fi 密码',
        passwordHint: '开放网络可留空；密码不会保存到 App 设置或日志。',
        fallbackHost: '电脑后备局域网 IP',
        configuredNetwork: '当前配置：{ssid}',
        sending: '正在安全写入配置…',
        applying: '配置已保存，水墨屏正在连接 Wi-Fi…',
        desktopUnreachable: 'Wi-Fi 已连接，正在查找并验证 CodePulse App…',
        wifiError: 'Wi-Fi 连接失败，请检查名称、密码和信号后重试。',
        ready: '配网成功：水墨屏已完成鉴权状态请求。',
        cancelled: '配网已取消。',
        timeout: '等待设备就绪超时，请检查网络后重试。',
        invalidInput: 'Wi-Fi 或后备地址格式不正确。',
        deviceMismatch: 'USB 设备身份发生变化，请重新扫描。',
        failed: '配网失败，请重新连接设备后重试。',
        lanVerified: '已通过 mDNS 与 17890 health 核对设备身份。',
        lanWaiting: '正在等待水墨屏的局域网服务广播。',
        cancel: '取消',
        provisioning: '配网中…',
        provision: '开始配网',
        securityNote:
          '串口操作只在主进程执行；设备 token 不会发送给界面，密码和 token 均不会写入日志。',
      },
    },
  },
  en: {
    project: 'Projects',
    recent: 'Recent',
    model: 'Model',
    thinkingDepth: 'Thinking depth',
    elapsed: 'Elapsed',
    fiveHourQuota: '5h quota',
    weeklyQuota: 'Weekly quota',
    waitingQuota: 'Waiting for CLI quota sync',
    read: 'Read',
    readAll: 'Read all',
    complete: 'Done',
    dismissProjectCard: 'Temporarily hide project card',
    attentionRailTitle: 'Needs attention',
    attentionRailHint: 'Orange projects stay visible across layouts and hidden tools',
    contextWindow: 'Context window:',
    unknownProject: 'Unknown project',
    emptyDashboard: {
      title: 'Waiting for CLI tasks',
      body: 'Panels appear when you start Claude Code, Codex, Grok, or Kimi tasks. If you only use one CLI, only that panel is shown.',
      agentTitle: 'No active sessions',
      agentBody: '{agent} is idle and ready when you are.',
      settingsHiddenTitle: 'All CLI tools are hidden',
      settingsHiddenBody: 'Open settings in the upper-right corner to choose tools to display.',
    },
    agentSetupReminder: {
      title: 'Setup and permission check',
      body: 'CodePulse HUD checks local Claude / Codex / Grok / Kimi setup every time it opens. Resolve these items first or task status may not sync.',
      firstRunNotice:
        'On first launch, CodePulse HUD writes the required hook configuration to ~/.claude/settings.json, ~/.codex/hooks.json, ~/.codex/config.toml, ~/.grok/hooks/codepulse.json, and ~/.kimi-code/config.toml.',
      cleanupNotice:
        'When CodePulse HUD is uninstalled, the installer removes those CodePulse hooks and statusLine entries automatically. Your other hooks, models, plugins, and preferences are preserved.',
      missingCli: 'CLI not detected',
      missingHook: 'CodePulse hook is not configured',
    },
    codexTrustTutorial: {
      title: 'Trust the Codex hook',
      body: 'CodePulse HUD has written the Codex hook configuration. Codex requires you to trust that command before it can run; otherwise the HUD cannot receive Codex task status.',
      permissionsTitle: 'CodePulse permissions to trust in /hooks',
      permissions: [
        'SessionStart: detect Codex session start and project directory.',
        'UserPromptSubmit: detect that a new turn was submitted.',
        'PreToolUse / PermissionRequest / PostToolUse: detect tool execution, permission waits, and tool completion.',
        'Stop: detect that one Codex turn completed and mark that project orange in the HUD until acknowledged.',
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
      body: 'A new CodePulse HUD version is available. Update now downloads the installer (~70MB), opens it, and quits this app. This may take a few minutes — keep your network connected.',
      manualBody:
        'A new CodePulse HUD version is available, but this release has no matching Windows installer. Open the release page to review it.',
      currentVersion: 'Current',
      latestVersion: 'Latest',
      whatsNew: "What's new",
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
      compressedPrefix: 'compressed: ',
      left: 'left',
      used: 'used',
    },
    pathStatus: {
      waitingProjectPath: 'Waiting for project path',
      waitingDirectory: 'Waiting for directory',
      projectRoot: 'Project root',
    },
    settings: {
      title: 'Settings',
      close: 'Close settings',
      hudAppearance: 'HUD appearance',
      hudOpacity: 'Background opacity',
      hudOpacityHint: 'Only the panel background fades; text, icons, and controls stay crisp.',
      attentionEffect: 'Orange attention motion',
      attentionEffectHint:
        'Orange is reserved for intervention; reduced-motion preferences always disable animation.',
      attentionSteady: 'Steady',
      attentionBreathe: 'Breathe',
      attentionPulse: 'Flash',
      projectLayout: 'Project layout',
      projectLayoutHint:
        'The default column shrinks with the project stack; switch to the grid for parallel scanning.',
      projectLayoutGrid: 'Compact grid',
      projectLayoutList: 'Sorted column',
      usageStrip: 'Show usage strip',
      usageStripHint: 'Keep quota summaries without recreating Claude, Codex, or Grok sections.',
      resultRetention: 'Project card retention',
      resultRetentionHint:
        'How long idle, cancelled, or acknowledged result cards remain in the HUD.',
      resultRetentionOptions: [
        { minutes: 10, label: '10 min' },
        { minutes: 30, label: '30 min' },
        { minutes: 60, label: '1 hour' },
        { minutes: 120, label: '2 hours' },
        { minutes: 240, label: '4 hours' },
      ],
      theme: 'Theme',
      themeAuto: 'Auto',
      themeAutoHint: 'Automatic: light from 08:00–20:00 and dark otherwise.',
      themeLight: 'White',
      themeDark: 'Black',
      cliTools: 'Visible CLI tools',
      cliToolsHint: 'Hiding a tool only changes the HUD; syncing and status cues continue.',
      codex: 'Codex',
      claudeCode: 'Claude Code',
      grok: 'Grok',
      kimi: 'Kimi Code',
      deviceProvisioning: {
        title: 'CodePulse display',
        description:
          'Connect over USB to identify and provision Wi-Fi. Power on normally by holding the function button for 3 seconds; do not press BOOT.',
        scan: 'Scan again',
        scanning: 'Scanning…',
        unavailable:
          'This main process does not support device provisioning. Restart or update CodePulse.',
        serverUnavailable:
          'The device API is disabled. For development, run CODEPULSE_DEVICE_SERVER_ENABLED=1 pnpm dev.',
        serverReady: 'Device API ready; fallback address: {host}:17889',
        connectHint: 'Looking for a USB display. Connect it and power it on normally.',
        noDevice: 'No CodePulse USB display found. Connect one and scan again.',
        wifiSsid: 'Wi-Fi name (SSID)',
        wifiPassword: 'Wi-Fi password',
        passwordHint:
          'Leave blank for an open network. The password is never saved in app settings or logs.',
        fallbackHost: 'Computer fallback LAN IP',
        configuredNetwork: 'Current network: {ssid}',
        sending: 'Securely writing configuration…',
        applying: 'Configuration saved. The display is connecting to Wi-Fi…',
        desktopUnreachable: 'Wi-Fi connected. Discovering and authenticating with CodePulse…',
        wifiError: 'Wi-Fi failed. Check the network name, password, and signal, then retry.',
        ready: 'Provisioning complete: the display made an authenticated status request.',
        cancelled: 'Provisioning cancelled.',
        timeout: 'Timed out waiting for the display. Check the network and retry.',
        invalidInput: 'The Wi-Fi or fallback address is invalid.',
        deviceMismatch: 'The USB device identity changed. Scan again.',
        failed: 'Provisioning failed. Reconnect the display and retry.',
        lanVerified: 'Device identity verified through mDNS and the port 17890 health endpoint.',
        lanWaiting: 'Waiting for the display to advertise its LAN service.',
        cancel: 'Cancel',
        provisioning: 'Provisioning…',
        provision: 'Start provisioning',
        securityNote:
          'Serial operations stay in the main process. The UI never receives the device token, and passwords/tokens are never logged.',
      },
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

const THINKING_DEPTH_LABELS: Record<Locale, Record<string, string>> = {
  zh: {
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '极高',
    max: '最高',
    ultra: '超高',
  },
  en: {
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
    ultra: 'Ultra',
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

/**
 * Gives completion a distinct acknowledgement label while live intervention
 * states keep the familiar read action.
 */
export function acknowledgementLabel(
  state: TurnState,
  hasWorkspace: boolean,
  copy: Pick<UiCopy, 'read' | 'readAll' | 'complete'>,
): string {
  if (state === TurnState.DONE) return copy.complete
  return hasWorkspace ? copy.read : copy.readAll
}

/**
 * Formats a native CLI reasoning-effort value for the active dashboard locale.
 *
 * Unknown future values stay visible rather than being guessed from token usage.
 *
 * @param effort Native model reasoning-effort string.
 * @param locale Dashboard locale.
 * @returns Localized depth label, the raw unknown value, or an em dash.
 */
export function formatThinkingDepth(effort: string | undefined, locale: Locale): string {
  if (!effort?.trim()) return '—'
  const normalized = effort.trim().toLowerCase()
  return THINKING_DEPTH_LABELS[locale][normalized] ?? effort
}

export function readStoredLocale(storage: LocaleStorageLike | undefined): Locale {
  const value = storage?.getItem('codepulse:locale')
  return value === 'en' ? 'en' : 'zh'
}

import type { OverallState } from '@codepulse/shared'
import { TurnState } from '@codepulse/shared'

export type Locale = 'zh' | 'en'

export interface HeaderCopy {
  brandTag: string
  subtitle: string
  mute: string
  muted: string
  languageToggle: string
  /** Local stats / insights console */
  stats: string
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
  contextWindow: string
  unknownProject: string
  emptyDashboard: EmptyDashboardCopy
  agentSetupReminder: AgentSetupReminderCopy
  codexTrustTutorial: CodexTrustTutorialCopy
  updateAvailable: UpdateAvailableCopy
  contextStatus: ContextStatusCopy
  pathStatus: PathStatusCopy
  settings: SettingsCopy
  stats: StatsCopy
}

/**
 * Localized labels for display-only dashboard preferences.
 *
 * `cliToolsHint` must make clear that hiding a panel never stops local sync or notifications.
 */
export interface SettingsCopy {
  title: string
  close: string
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

export interface StatsCopy {
  title: string
  subtitle: string
  close: string
  backToLive: string
  pageTitle: string
  pageSubtitle: string
  overview: string
  overviewHint: string
  rangeToday: string
  range7d: string
  range30d: string
  refresh: string
  refreshing: string
  granularityDay: string
  granularityWeek: string
  granularityMonth: string
  noData: string
  privacyNote: string
  /** KPI */
  kpiTotalTokens: string
  kpiTotalDuration: string
  kpiProjects: string
  kpiAvgDailyTokens: string
  kpiAvgDailyDuration: string
  kpiDialogs: string
  vsPrev: string
  vsPrevWeek: string
  /** Charts */
  tokenTrendTitle: string
  durationTrendTitle: string
  modelMixTitle: string
  heatmapTitle: string
  projectRankTitle: string
  insightsTitle: string
  projectTypeTitle: string
  fileTypeTitle: string
  dialogBucketTitle: string
  efficiencyTitle: string
  /** Table columns */
  colRank: string
  colProject: string
  colTokens: string
  colShare: string
  colDuration: string
  colDialogs: string
  colLastActive: string
  /** Categories */
  projectTypeTool: string
  projectTypeResearch: string
  projectTypeWeb: string
  projectTypeOther: string
  bucket0_500: string
  bucket500_2k: string
  bucket2k_5k: string
  bucket5k_10k: string
  bucket10k_plus: string
  /** Efficiency */
  gradeExcellent: string
  gradeGood: string
  gradeFair: string
  gradeLow: string
  scoreCodeGen: string
  scoreProblemSolve: string
  scoreDialogQuality: string
  scoreFocus: string
  weekdayLabels: string[]
  /** Insights templates */
  insightPeakDay: string
  insightPeakDayDetail: string
  insightTopModel: string
  insightTopModelDetail: string
  insightEfficiency: string
  insightEfficiencyDetail: string
  insightPeakHour: string
  insightPeakHourDetail: string
  insightEmpty: string
  insightEmptyDetail: string
  otherModels: string
  loading: string
  syncFailed: string
  /** SQLite 未打开：实时面板可用，但历史统计为空 */
  persistenceUnavailable: string
  /** 库可用但时间范围内无记录 */
  emptyHistory: string
  queryFailed: string
}

/** Localized content for an idle dashboard and the intentional all-tools-hidden state. */
export interface EmptyDashboardCopy {
  title: string
  body: string
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
    subtitle: '编程助手实时控制台',
    mute: '静音 30 分钟',
    muted: '已静音',
    languageToggle: '英文',
    stats: '后台',
    settings: '设置',
  },
  en: {
    brandTag: '',
    subtitle: 'AI coding-agent live console',
    mute: 'Mute 30 min',
    muted: 'Muted',
    languageToggle: 'Chinese',
    stats: 'Insights',
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
    contextWindow: '上下文窗口：',
    unknownProject: '未识别项目',
    emptyDashboard: {
      title: '等待 CLI 任务',
      body: '开始 Claude Code、Codex、Grok 或 Kimi 任务后，对应分屏会自动出现；只用一个 CLI 时只显示一栏。',
      settingsHiddenTitle: '所有 CLI 工具已隐藏',
      settingsHiddenBody: '打开右上角设置，重新选择要显示的 CLI 工具。',
    },
    agentSetupReminder: {
      title: '配置与权限检查',
      body: 'CodePulse 每次打开都会检查本机 Claude / Codex / Grok / Kimi 配置。请先处理下面的问题，否则任务状态可能无法同步。',
      firstRunNotice:
        '首次打开时，CodePulse 会在 ~/.claude/settings.json、~/.codex/hooks.json、~/.codex/config.toml、~/.grok/hooks/codepulse.json 和 ~/.kimi-code/config.toml 写入必要的 CodePulse hook 配置。',
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
      theme: '主题',
      themeAuto: '自动',
      themeAutoHint: '自动：08:00–20:00 白色，20:00–08:00 黑色。',
      themeLight: '白色',
      themeDark: '黑色',
      cliTools: '显示的 CLI 工具',
      cliToolsHint: '隐藏仅影响主控制台显示，不会停止本机同步或通知。',
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
    stats: {
      title: '本地开发数据统计',
      subtitle: '专注于本地开发效率与资源消耗分析，帮助团队做出更优决策',
      close: '关闭',
      backToLive: '退出大屏',
      pageTitle: '概览',
      pageSubtitle: '全面掌握本地开发活动与资源消耗情况',
      overview: '概览',
      overviewHint: '数据来自本机 SQLite，点击刷新可同步最新记录',
      rangeToday: '今日',
      range7d: '近 7 天',
      range30d: '近 30 天',
      refresh: '刷新数据',
      refreshing: '同步中…',
      granularityDay: '按日',
      granularityWeek: '按周',
      granularityMonth: '按月',
      noData: '暂无统计数据。开始 CLI 任务后，后台会自动汇总 Token、耗时与项目。',
      privacyNote: '数据仅存本机，不上传云端。',
      kpiTotalTokens: '总消耗 Token',
      kpiTotalDuration: '总开发时长',
      kpiProjects: '总项目数',
      kpiAvgDailyTokens: '日均 Token',
      kpiAvgDailyDuration: '日均开发时长',
      kpiDialogs: '总对话次数',
      vsPrev: '较上期',
      vsPrevWeek: '较上周',
      tokenTrendTitle: 'Token 消耗趋势',
      durationTrendTitle: '开发时长趋势',
      modelMixTitle: '模型使用占比',
      heatmapTitle: '高峰时段分布',
      projectRankTitle: '项目消耗排行',
      insightsTitle: '使用洞察',
      projectTypeTitle: '项目类型分布',
      fileTypeTitle: '文件类型分布',
      dialogBucketTitle: '单次对话消耗分布 (Token)',
      efficiencyTitle: '本地开发效率评分',
      colRank: '#',
      colProject: '项目名称',
      colTokens: 'Token 消耗',
      colShare: '占比',
      colDuration: '开发时长',
      colDialogs: '对话次数',
      colLastActive: '最后活跃',
      projectTypeTool: '工具/脚本',
      projectTypeResearch: '研究/实验',
      projectTypeWeb: 'Web 应用',
      projectTypeOther: '其他',
      bucket0_500: '0-500',
      bucket500_2k: '500-2K',
      bucket2k_5k: '2K-5K',
      bucket5k_10k: '5K-10K',
      bucket10k_plus: '10K+',
      gradeExcellent: '优秀',
      gradeGood: '良好',
      gradeFair: '一般',
      gradeLow: '待提升',
      scoreCodeGen: '代码生成效率',
      scoreProblemSolve: '问题解决效率',
      scoreDialogQuality: '对话质量',
      scoreFocus: '持续专注度',
      weekdayLabels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
      insightPeakDay: '峰值日使用最高',
      insightPeakDayDetail: '{day} Token 消耗达峰值 {tokens}',
      insightTopModel: '模型使用占比最高',
      insightTopModelDetail: '{model} 占比 {percent}%，建议关注成本',
      insightEfficiency: '效率提升建议',
      insightEfficiencyDetail: '平均每次对话消耗 {avgTokens} Token，可优化提示',
      insightPeakHour: '活跃高峰',
      insightPeakHourDetail: '{weekday} {hour}:00 附近最活跃（{value} 次事件）',
      insightEmpty: '等待数据',
      insightEmptyDetail: '近 {days} 天尚无足够记录，开始 CLI 任务后自动同步。',
      otherModels: '其他',
      loading: '正在同步本地数据…',
      syncFailed: '同步失败，请稍后重试',
      persistenceUnavailable:
        '本机历史库未就绪（SQLite 不可用）。实时控制台仍可工作，但统计需要落盘后的本地数据。请确认安装包完整，或查看主进程日志中的 SQLite 错误。',
      emptyHistory:
        '当前时间范围内没有本地历史记录。统计只读 SQLite（%APPDATA%\\CodePulse\\codepulse.sqlite），不会读取实时内存状态。请在本安装实例下再跑几轮 CLI 任务后点「刷新数据」。',
      queryFailed: '统计聚合失败：{error}',
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
    contextWindow: 'Context window:',
    unknownProject: 'Unknown project',
    emptyDashboard: {
      title: 'Waiting for CLI tasks',
      body: 'Panels appear when you start Claude Code, Codex, Grok, or Kimi tasks. If you only use one CLI, only that panel is shown.',
      settingsHiddenTitle: 'All CLI tools are hidden',
      settingsHiddenBody: 'Open settings in the upper-right corner to choose tools to display.',
    },
    agentSetupReminder: {
      title: 'Setup and permission check',
      body: 'CodePulse checks local Claude / Codex / Grok / Kimi setup every time it opens. Resolve these items first or task status may not sync.',
      firstRunNotice:
        'On first launch, CodePulse writes the required hook configuration to ~/.claude/settings.json, ~/.codex/hooks.json, ~/.codex/config.toml, ~/.grok/hooks/codepulse.json, and ~/.kimi-code/config.toml.',
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
      theme: 'Theme',
      themeAuto: 'Auto',
      themeAutoHint: 'Automatic: light from 08:00–20:00 and dark otherwise.',
      themeLight: 'White',
      themeDark: 'Black',
      cliTools: 'Visible CLI tools',
      cliToolsHint:
        'Hiding a tool only changes the live console; syncing and notifications continue.',
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
    stats: {
      title: 'Local development analytics',
      subtitle: 'Local efficiency and resource analysis — nothing leaves this machine',
      close: 'Close',
      backToLive: 'Exit',
      pageTitle: 'Overview',
      pageSubtitle: 'Local development activity and resource consumption at a glance',
      overview: 'Overview',
      overviewHint: 'Data from local SQLite. Refresh syncs the latest records.',
      rangeToday: 'Today',
      range7d: 'Last 7 days',
      range30d: 'Last 30 days',
      refresh: 'Refresh',
      refreshing: 'Syncing…',
      granularityDay: 'Day',
      granularityWeek: 'Week',
      granularityMonth: 'Month',
      noData: 'No stats yet. Start a CLI task and tokens, time, and projects will roll up here.',
      privacyNote: 'Local only — nothing is uploaded.',
      kpiTotalTokens: 'Total tokens',
      kpiTotalDuration: 'Total coding time',
      kpiProjects: 'Projects',
      kpiAvgDailyTokens: 'Avg daily tokens',
      kpiAvgDailyDuration: 'Avg daily time',
      kpiDialogs: 'Dialogs',
      vsPrev: 'vs prev',
      vsPrevWeek: 'vs last period',
      tokenTrendTitle: 'Token usage trend',
      durationTrendTitle: 'Coding time trend',
      modelMixTitle: 'Model mix',
      heatmapTitle: 'Peak hours',
      projectRankTitle: 'Project ranking',
      insightsTitle: 'Insights',
      projectTypeTitle: 'Project types',
      fileTypeTitle: 'File types',
      dialogBucketTitle: 'Tokens per dialog',
      efficiencyTitle: 'Local efficiency score',
      colRank: '#',
      colProject: 'Project',
      colTokens: 'Tokens',
      colShare: 'Share',
      colDuration: 'Duration',
      colDialogs: 'Dialogs',
      colLastActive: 'Last active',
      projectTypeTool: 'Tools / scripts',
      projectTypeResearch: 'Research',
      projectTypeWeb: 'Web apps',
      projectTypeOther: 'Other',
      bucket0_500: '0-500',
      bucket500_2k: '500-2K',
      bucket2k_5k: '2K-5K',
      bucket5k_10k: '5K-10K',
      bucket10k_plus: '10K+',
      gradeExcellent: 'Excellent',
      gradeGood: 'Good',
      gradeFair: 'Fair',
      gradeLow: 'Needs work',
      scoreCodeGen: 'Code generation',
      scoreProblemSolve: 'Problem solving',
      scoreDialogQuality: 'Dialog quality',
      scoreFocus: 'Focus',
      weekdayLabels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      insightPeakDay: 'Peak day',
      insightPeakDayDetail: '{day} peaked at {tokens} tokens',
      insightTopModel: 'Top model',
      insightTopModelDetail: '{model} is {percent}% — watch cost',
      insightEfficiency: 'Efficiency tip',
      insightEfficiencyDetail: 'Avg {avgTokens} tokens per dialog — prompts can be tightened',
      insightPeakHour: 'Busy hour',
      insightPeakHourDetail: 'Most active around {weekday} {hour}:00 ({value} events)',
      insightEmpty: 'Waiting for data',
      insightEmptyDetail: 'Not enough records in the last {days} day(s). Start a CLI task to sync.',
      otherModels: 'Other',
      loading: 'Syncing local data…',
      syncFailed: 'Sync failed. Try again shortly.',
      persistenceUnavailable:
        'Local history DB is unavailable (SQLite did not open). The live console still works, but analytics needs on-disk data. Check that the installer is complete and look for SQLite errors in the main-process log.',
      emptyHistory:
        'No local history in this date range. Analytics reads only SQLite (not the in-memory live state). Run a few CLI turns with this installed app, then hit Refresh.',
      queryFailed: 'Stats aggregation failed: {error}',
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

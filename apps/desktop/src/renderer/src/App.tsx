/**
 * Dashboard 根组件。布局包含头部、agent 卡片网格与通知栏，
 * 并驱动高频时钟，使耗时与相对时间保持实时。
 *
 * @module renderer/App
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from 'react'
import {
  formatTokenPercent,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type UpdateDownloadProgress,
  type UpdateInfo,
  type UpdateProgressPhase,
  TurnState,
} from '@codepulse/shared'
import { useStore } from './store.js'
import { Header } from './components/Header.js'
import { SettingsDialog } from './components/SettingsDialog.js'
import { StatsDashboard } from './components/StatsDashboard.js'
import {
  acknowledgeCodexTrust,
  buildAgentSetupReminder,
  dismissAgentSetupReminder,
  readCodexTrustAcknowledged,
  shouldShowAgentSetupReminder,
  type AgentSetupReminder,
} from './lib/codexTrustTutorial.js'
import {
  buildAgentPanels,
  type AgentPanel,
  type AgentWorkspaceItem,
  type QuotaMeterSource,
} from './lib/displayAgents.js'
import { formatDuration, formatRelative, turnStateStyle } from './lib/format.js'
import {
  formatContextWindowStatus,
  formatProjectDirectoryBadge,
  showsFiveHourQuota,
  visibleRateLimitWindows,
} from './lib/panelFormat.js'
import { formatQuotaReset } from './lib/quotaFormat.js'
import { useNow } from './lib/useNow.js'
import { buildVirtualListLayout, findVirtualListRange } from './lib/virtualList.js'
import {
  applyTheme,
  CLI_TOOL_TYPES,
  millisecondsUntilScheduledThemeChange,
  readDashboardSettings,
  resolveTheme,
  writeDashboardSettings,
  type CliToolType,
  type DashboardSettings,
  type ThemeMode,
  type ThemePreference,
} from './lib/dashboardSettings.js'
import {
  formatThinkingDepth,
  nextLocale,
  readStoredLocale,
  turnStateLabel,
  uiCopy,
  type Locale,
  type UiCopy,
} from './lib/i18n.js'
import codePulseIcon from './assets/codepulse-icon.png'

/**
 * 应用外壳 Dashboard。
 *
 * @returns 渲染后的 Dashboard。
 */
export function App(): JSX.Element {
  // Select slices so update progress / mute ticks do not force unrelated work.
  const snapshot = useStore((s) => s.snapshot)
  const muted = useStore((s) => s.muted)
  const agents = useStore((s) => s.agents)
  const agentCheckId = useStore((s) => s.agentCheckId)
  const updateInfo = useStore((s) => s.updateInfo)
  const updateInstalling = useStore((s) => s.updateInstalling)
  const updateProgress = useStore((s) => s.updateProgress)
  const updateError = useStore((s) => s.updateError)
  const init = useStore((s) => s.init)
  const ack = useStore((s) => s.ack)
  const toggleMute = useStore((s) => s.toggleMute)
  const dismissUpdate = useStore((s) => s.dismissUpdate)
  const installUpdate = useStore((s) => s.installUpdate)
  const [locale, setLocale] = useState<Locale>(() => readStoredLocale(window.localStorage))
  const [dismissedAgentCheckId, setDismissedAgentCheckId] = useState<number | undefined>()
  const [codexTrustAcknowledged, setCodexTrustAcknowledged] = useState<boolean>(() =>
    readCodexTrustAcknowledged(window.localStorage),
  )
  /** 本地开发数据统计后台（设计稿大屏） */
  const [statsOpen, setStatsOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dashboardSettings, setDashboardSettings] = useState<DashboardSettings>(() =>
    readDashboardSettings(window.localStorage),
  )
  const allPanels = useMemo(() => buildAgentPanels(snapshot.agents), [snapshot.agents])
  const panels = useMemo(
    // Display preferences only filter renderer panels; hook delivery and disk sync keep running.
    () => allPanels.filter((panel) => dashboardSettings.visibleTools[panel.agentType]),
    [allPanels, dashboardSettings.visibleTools],
  )
  const visibleSessionCount = useMemo(
    () => snapshot.agents.filter((agent) => dashboardSettings.visibleTools[agent.agentType]).length,
    [dashboardSettings.visibleTools, snapshot.agents],
  )
  const allToolsHidden = useMemo(
    () => CLI_TOOL_TYPES.every((tool) => !dashboardSettings.visibleTools[tool]),
    [dashboardSettings.visibleTools],
  )
  const setupReminder = useMemo(() => buildAgentSetupReminder(agents), [agents])
  const copy = useMemo(() => uiCopy(locale), [locale])
  const showSetupReminder = shouldShowAgentSetupReminder(
    setupReminder,
    agentCheckId,
    dismissedAgentCheckId,
    codexTrustAcknowledged,
  )
  const now = useNow(30_000)
  const resolvedTheme = useScheduledTheme(dashboardSettings.theme)

  useEffect(() => {
    void window.codepulse.setLocale(locale)
  }, [locale])

  useLayoutEffect(() => {
    // Write before paint so the resolved palette never flashes its opposite color.
    applyTheme(document.documentElement, resolvedTheme)
  }, [resolvedTheme])

  useEffect(() => {
    // Storage may be unavailable; the writer deliberately preserves the in-memory selection.
    writeDashboardSettings(window.localStorage, dashboardSettings)
  }, [dashboardSettings])

  useEffect(() => init(), [init])

  const toggleLocale = (): void => {
    setLocale((current) => {
      const next = nextLocale(current)
      window.localStorage.setItem('codepulse:locale', next)
      return next
    })
  }

  const dismissSetupReminder = (): void => {
    setDismissedAgentCheckId(dismissAgentSetupReminder(agentCheckId))
    if (setupReminder.needsCodexTrust) {
      setCodexTrustAcknowledged(acknowledgeCodexTrust(window.localStorage))
    }
  }

  /** Apply one atomic preference update; persistence occurs after React commits the state. */
  const updateDashboardSettings = useCallback(
    (updater: (current: DashboardSettings) => DashboardSettings): void => {
      setDashboardSettings(updater)
    },
    [],
  )

  const setTheme = useCallback(
    (theme: ThemePreference): void => {
      updateDashboardSettings((current) => ({ ...current, theme }))
    },
    [updateDashboardSettings],
  )

  const setToolVisibility = useCallback(
    (tool: CliToolType, visible: boolean): void => {
      updateDashboardSettings((current) => ({
        ...current,
        visibleTools: { ...current.visibleTools, [tool]: visible },
      }))
    },
    [updateDashboardSettings],
  )

  const closeSettings = useCallback((): void => setSettingsOpen(false), [])

  const liveConsole = (
    <LiveConsole
      panels={panels}
      allToolsHidden={allToolsHidden}
      sessionCount={visibleSessionCount}
      updatedAt={snapshot.updatedAt}
      locale={locale}
      copy={copy}
      now={now}
      onAck={(agentType, workspacePath) => ack(agentType, workspacePath)}
    />
  )

  return (
    <div className="app-shell flex h-full flex-col text-ink">
      <Header
        locale={locale}
        muted={muted}
        onToggleLocale={toggleLocale}
        onToggleMute={toggleMute}
        onOpenStats={() => setStatsOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        statsActive={statsOpen}
        settingsOpen={settingsOpen}
      />
      {liveConsole}
      {showSetupReminder && (
        <AgentSetupReminderModal
          copy={copy}
          reminder={setupReminder}
          onConfirm={dismissSetupReminder}
        />
      )}
      {!showSetupReminder && updateInfo && (
        <UpdateAvailableModal
          copy={copy}
          error={updateError}
          installing={updateInstalling}
          progress={updateProgress}
          onDismiss={dismissUpdate}
          onInstall={installUpdate}
          update={updateInfo}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          copy={copy.settings}
          onClose={closeSettings}
          onThemeChange={setTheme}
          onToolVisibilityChange={setToolVisibility}
          theme={dashboardSettings.theme}
          visibleTools={dashboardSettings.visibleTools}
        />
      )}
      {statsOpen && (
        <StatsDashboard locale={locale} copy={copy} onClose={() => setStatsOpen(false)} />
      )}
    </div>
  )
}

/**
 * Resolves the selected theme and reschedules automatic changes at local 08:00 and 20:00.
 *
 * Refreshing on focus and visibility changes also corrects the palette immediately after
 * sleep or when the system clock changes while the app is hidden.
 *
 * @param preference Persisted user theme selection.
 * @returns Concrete palette currently suitable for the document root.
 */
function useScheduledTheme(preference: ThemePreference): ThemeMode {
  const [, setRefreshVersion] = useState(0)

  useEffect(() => {
    if (preference !== 'auto') return

    let timeoutId: number | undefined
    const scheduleNextChange = (): void => {
      const observedAt = new Date()
      setRefreshVersion((version) => version + 1)
      timeoutId = window.setTimeout(
        scheduleNextChange,
        millisecondsUntilScheduledThemeChange(observedAt),
      )
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      scheduleNextChange()
    }

    scheduleNextChange()
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('focus', refreshWhenVisible)
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('focus', refreshWhenVisible)
    }
  }, [preference])

  return resolveTheme(preference)
}

/** 实时三栏控制台主体 + 底栏（与设计稿一致） */
function LiveConsole({
  allToolsHidden,
  panels,
  sessionCount,
  updatedAt,
  locale,
  copy,
  now,
  onAck,
}: {
  allToolsHidden: boolean
  panels: AgentPanel[]
  sessionCount: number
  updatedAt: number
  locale: Locale
  copy: UiCopy
  now: number
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  return (
    <>
      <div className="min-h-0 flex-1 overflow-hidden px-5 pb-3">
        <main className="h-full min-w-0 overflow-x-auto overflow-y-hidden pr-1">
          {panels.length === 0 ? (
            <EmptyDashboard allToolsHidden={allToolsHidden} copy={copy} />
          ) : (
            <div className={`grid h-full items-stretch gap-4 ${panelGridClass(panels.length)}`}>
              {panels.map((panel) => (
                <AgentPanelView
                  key={panel.agentType}
                  panel={panel}
                  locale={locale}
                  copy={copy}
                  onAck={onAck}
                />
              ))}
            </div>
          )}
        </main>
      </div>
      <footer className="footer-strip flex shrink-0 items-center justify-between gap-3 px-6 py-2.5">
        <span>
          {panels.length === 0
            ? allToolsHidden
              ? copy.emptyDashboard.settingsHiddenTitle
              : copy.emptyDashboard.title
            : locale === 'zh'
              ? `${panels.length} 个助手分屏 · ${sessionCount} 个会话`
              : `${panels.length} panels · ${sessionCount} sessions`}
        </span>
        <span className="tabular-nums">
          {locale === 'zh'
            ? `同步 ${formatRelative(updatedAt, now, locale)}`
            : `Synced ${formatRelative(updatedAt, now, locale)}`}
        </span>
      </footer>
    </>
  )
}

function UpdateAvailableModal({
  copy,
  update,
  installing,
  progress,
  error,
  onDismiss,
  onInstall,
}: {
  copy: UiCopy
  update: UpdateInfo
  installing: boolean
  progress: UpdateDownloadProgress | undefined
  error: string | undefined
  onDismiss: () => void
  onInstall: () => void
}): JSX.Element {
  const updateCopy = copy.updateAvailable
  const actionText = update.installable ? updateCopy.install : updateCopy.openRelease
  const phase: UpdateProgressPhase = progress?.phase ?? (installing ? 'preparing' : 'preparing')
  const downloadPercent =
    typeof progress?.percent === 'number'
      ? Math.min(100, Math.max(0, progress.percent))
      : phase === 'verifying' || phase === 'launching'
        ? 100
        : undefined
  const downloadDone = downloadPercent === 100 || phase === 'verifying' || phase === 'launching'
  const installActive = phase === 'verifying' || phase === 'launching'
  const installDone = phase === 'launching'
  const installWidth = installDone ? '100%' : installActive ? '55%' : '0%'

  const installingLabel = !installing
    ? actionText
    : phase === 'launching'
      ? updateCopy.phaseLaunching
      : phase === 'verifying'
        ? updateCopy.phaseVerifying
        : typeof downloadPercent === 'number'
          ? updateCopy.downloadingPercent.replace('{percent}', String(downloadPercent))
          : updateCopy.installing

  const downloadStatus =
    phase === 'preparing'
      ? updateCopy.phasePreparing
      : phase === 'downloading'
        ? updateCopy.phaseDownloading
        : downloadDone
          ? '100%'
          : updateCopy.phasePreparing

  const installStatus = installDone
    ? updateCopy.installReady
    : installActive
      ? updateCopy.phaseVerifying
      : updateCopy.installWaiting

  const sizeLabel = formatDownloadSize(progress?.received, progress?.total)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20 px-4 backdrop-blur-sm">
      <section
        aria-modal="true"
        className="liquid-glass w-full max-w-[28rem] p-5 shadow-card-hover"
        role="dialog"
      >
        <div className="flex items-start gap-3">
          <img
            src={codePulseIcon}
            alt=""
            className="h-12 w-12 shrink-0 rounded-full object-contain shadow-soft"
          />
          <div className="min-w-0">
            <h2 className="text-xl font-semibold text-ink">{updateCopy.title}</h2>
            <p className="mt-2 text-sm leading-6 text-ink-500">
              {update.installable ? updateCopy.body : updateCopy.manualBody}
            </p>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="stat-pill">
            <p className="text-xs font-medium text-ink-500">{updateCopy.currentVersion}</p>
            <p className="mt-1 truncate text-sm font-semibold text-ink">v{update.currentVersion}</p>
          </div>
          <div className="stat-pill border-emerald-200 bg-emerald-50/80">
            <p className="text-xs font-medium text-emerald-700">{updateCopy.latestVersion}</p>
            <p className="mt-1 truncate text-sm font-semibold text-emerald-900">{update.tag}</p>
          </div>
        </div>

        {update.releaseNotes && update.releaseNotes.length > 0 ? (
          <div className="mt-4 rounded-card border border-line bg-white/90 px-3.5 py-3 shadow-soft">
            <p className="text-xs font-semibold text-ink">{updateCopy.whatsNew}</p>
            <ul className="agent-project-list mt-2 max-h-36 space-y-1.5 overflow-y-auto pr-1">
              {update.releaseNotes.map((note) => (
                <li key={note} className="flex gap-2 text-[13px] leading-5 text-ink-700">
                  <span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-brand-codex" aria-hidden />
                  <span className="min-w-0">{note}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {installing && (
          <div className="mt-4 grid gap-3 rounded-card border border-line bg-white/90 px-3.5 py-3 shadow-soft">
            <p className="text-xs font-medium text-ink-500">{updateCopy.downloadingHint}</p>

            {/* 1. Download progress */}
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink">{updateCopy.stepDownload}</span>
                <span className="tabular-nums font-semibold text-ink-700">
                  {typeof downloadPercent === 'number' ? `${downloadPercent}%` : downloadStatus}
                </span>
              </div>
              <div className="meter-track h-2">
                <div
                  className={`meter-fill brand-codex transition-[width] duration-200 ${
                    typeof downloadPercent === 'number' || downloadDone ? '' : 'animate-pulse'
                  }`}
                  style={{
                    width:
                      typeof downloadPercent === 'number'
                        ? `${Math.max(downloadPercent > 0 ? downloadPercent : 2, downloadPercent === 0 ? 2 : downloadPercent)}%`
                        : installing
                          ? '12%'
                          : '0%',
                  }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] font-medium text-ink-500">
                <span className="truncate">
                  {phase === 'preparing'
                    ? updateCopy.phasePreparing
                    : phase === 'downloading'
                      ? updateCopy.phaseDownloading
                      : downloadDone
                        ? updateCopy.phaseVerifying
                        : updateCopy.phasePreparing}
                </span>
                {sizeLabel ? <span className="shrink-0 tabular-nums">{sizeLabel}</span> : null}
              </div>
            </div>

            {/* 2. Install / launch progress */}
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                <span className="font-semibold text-ink">{updateCopy.stepInstall}</span>
                <span className="tabular-nums font-semibold text-ink-700">
                  {installDone ? '100%' : installActive ? '…' : '—'}
                </span>
              </div>
              <div className="meter-track h-2">
                <div
                  className={`meter-fill brand-grok transition-[width] duration-300 ${
                    installActive && !installDone ? 'animate-pulse' : ''
                  }`}
                  style={{ width: installWidth }}
                />
              </div>
              <p className="mt-1.5 truncate text-[11px] font-medium text-ink-500">
                {installStatus}
              </p>
            </div>
          </div>
        )}

        {error && (
          <p className="mt-3 rounded-badge border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700">
            {updateCopy.failed} {error}
          </p>
        )}

        <div className="mt-5 grid grid-cols-[0.8fr_1.2fr] gap-2">
          <button
            className="control-btn h-11 justify-center"
            disabled={installing}
            onClick={onDismiss}
          >
            {updateCopy.later}
          </button>
          <button
            className="inline-flex h-11 items-center justify-center rounded-badge bg-ink px-4 text-sm font-semibold text-white shadow-soft transition hover:bg-ink-700 active:translate-y-px disabled:cursor-wait disabled:bg-ink-500"
            disabled={installing}
            onClick={onInstall}
          >
            {installingLabel}
          </button>
        </div>
      </section>
    </div>
  )
}

function formatDownloadSize(
  received: number | undefined,
  total: number | undefined,
): string | undefined {
  if (typeof received !== 'number' || received < 0) return undefined
  if (typeof total === 'number' && total > 0) {
    return `${formatBytes(received)} / ${formatBytes(total)}`
  }
  if (received > 0) return formatBytes(received)
  return undefined
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function AgentSetupReminderModal({
  copy,
  reminder,
  onConfirm,
}: {
  copy: UiCopy
  reminder: AgentSetupReminder
  onConfirm: () => void
}): JSX.Element {
  const tutorial = copy.codexTrustTutorial
  const setup = copy.agentSetupReminder
  const issues = [
    ...reminder.missingCli.map((agent) => ({
      label: setup.missingCli,
      agent,
    })),
    ...reminder.missingHook.map((agent) => ({
      label: setup.missingHook,
      agent,
    })),
  ]
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/20 px-4 backdrop-blur-sm">
      <section
        aria-modal="true"
        className="liquid-glass flex max-h-[min(calc(100vh-2rem),42rem)] w-full max-w-[30rem] flex-col overflow-hidden shadow-card-hover"
        role="dialog"
      >
        <div className="min-h-0 flex-1 overflow-y-auto p-5 pr-4">
          <div className="flex items-start gap-3">
            <span className="agent-brand-icon" data-agent="codex">
              <CodexLogo />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold text-ink">{setup.title}</h2>
              <p className="mt-2 text-sm leading-6 text-ink-500">{setup.body}</p>
            </div>
          </div>

          <div className="mt-4 grid gap-2 rounded-card border border-line bg-white px-3 py-3 text-sm leading-6 text-ink-700 shadow-soft">
            <p>{setup.firstRunNotice}</p>
            <p>{setup.cleanupNotice}</p>
          </div>

          {issues.length > 0 && (
            <div className="mt-4 grid gap-2.5">
              {issues.map((issue) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-badge border border-line bg-white px-3 py-2.5 text-sm shadow-soft"
                  key={`${issue.agent}:${issue.label}`}
                >
                  <span className="font-medium text-ink-700">{issue.label}</span>
                  <span className="rounded-full bg-ink px-2.5 py-1 text-xs font-semibold text-white">
                    {agentName(issue.agent)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {reminder.needsCodexTrust && (
            <>
              <div className="mt-4 rounded-card border border-line bg-white px-3 py-3 shadow-soft">
                <h3 className="text-sm font-semibold text-ink">{tutorial.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-ink-500">{tutorial.body}</p>
              </div>

              <div className="mt-3 rounded-card border border-line bg-white px-3 py-3 shadow-soft">
                <h4 className="text-sm font-semibold text-ink">{tutorial.permissionsTitle}</h4>
                <ul className="mt-2 grid gap-1.5 text-sm leading-6 text-ink-700">
                  {tutorial.permissions.map((permission) => (
                    <li key={permission}>{permission}</li>
                  ))}
                </ul>
              </div>

              <ol className="mt-3 grid gap-2.5">
                {tutorial.steps.map((step, index) => (
                  <li
                    className="flex gap-3 rounded-badge border border-line bg-white px-3 py-2.5 text-sm text-ink-700 shadow-soft"
                    key={step}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-brand-codex ring-1 ring-indigo-100">
                      {index + 1}
                    </span>
                    <span className="leading-6">{step}</span>
                  </li>
                ))}
              </ol>

              <p className="mt-3 rounded-badge border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
                {tutorial.warning}
              </p>
            </>
          )}
        </div>

        <div className="shrink-0 border-t border-line bg-white/70 p-5 pt-4">
          <button
            className="inline-flex h-11 w-full items-center justify-center rounded-badge bg-ink px-4 text-sm font-semibold text-white shadow-soft transition hover:bg-ink-700 active:translate-y-px"
            onClick={onConfirm}
          >
            {tutorial.action}
          </button>
        </div>
      </section>
    </div>
  )
}

function agentName(agent: AgentType): string {
  if (agent === 'codex') return 'Codex'
  if (agent === 'grok') return 'Grok'
  return 'Claude Code'
}

/** 按已启用 CLI 分屏数量自适应列布局。 */
function panelGridClass(count: number): string {
  if (count <= 1) return 'min-w-0 grid-cols-1'
  if (count === 2) {
    return 'min-w-[56rem] grid-cols-[minmax(27rem,1fr)_minmax(27rem,1fr)]'
  }
  return 'min-w-[84rem] grid-cols-[minmax(26rem,1fr)_minmax(26rem,1fr)_minmax(26rem,1fr)]'
}

/** Renders the appropriate empty state for either inactive or intentionally hidden tools. */
function EmptyDashboard({
  allToolsHidden,
  copy,
}: {
  allToolsHidden: boolean
  copy: UiCopy
}): JSX.Element {
  return (
    <div className="agent-panel flex h-full min-h-0 flex-col items-center justify-center px-6 text-center">
      <p className="text-lg font-semibold text-ink">
        {allToolsHidden ? copy.emptyDashboard.settingsHiddenTitle : copy.emptyDashboard.title}
      </p>
      <p className="mt-2 max-w-md text-sm leading-6 text-ink-500">
        {allToolsHidden ? copy.emptyDashboard.settingsHiddenBody : copy.emptyDashboard.body}
      </p>
    </div>
  )
}

const AgentPanelView = memo(function AgentPanelView({
  panel,
  locale,
  copy,
  onAck,
}: {
  panel: AgentPanel
  locale: Locale
  copy: UiCopy
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  const latest = panel.workspaces[0]?.agent
  const style = turnStateStyle(latest?.state ?? TurnState.IDLE)
  const projectCount = panel.workspaces.filter((item) => item.agent.lastEventAt > 0).length
  const brand = brandClass(panel.agentType)

  return (
    <section className="agent-panel flex min-h-0 flex-col p-3.5" data-agent={panel.agentType}>
      <div className="mb-3 flex flex-col gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="agent-brand-icon relative" data-agent={panel.agentType}>
            <AgentLogo agentType={panel.agentType} />
            <span
              className={`absolute bottom-1 right-1 h-2.5 w-2.5 rounded-full ring-2 ring-white ${style.dot}`}
            />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="truncate text-module text-ink">{panel.name}</h2>
              <span className={`status-badge ${stateChipClass(latest?.state ?? TurnState.IDLE)}`}>
                {turnStateLabel(latest?.state ?? TurnState.IDLE, locale)}
              </span>
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-[4.4rem_5.7rem] gap-2 text-sm">
            <Metric label={copy.project} value={String(projectCount || panel.workspaces.length)} />
            <Metric
              label={copy.recent}
              value={<RelativeTime timestamp={latest?.lastEventAt} locale={locale} />}
            />
          </div>
        </div>
        <PanelQuotaMeter
          agentType={panel.agentType}
          brand={brand}
          meters={panel.quotaMeters}
          locale={locale}
          copy={copy}
        />
      </div>
      <ProjectList
        agentType={panel.agentType}
        brand={brand}
        copy={copy}
        items={panel.workspaces}
        locale={locale}
        onAck={onAck}
      />
    </section>
  )
})

/** Avoids observer and absolute-positioning overhead for short project lists. */
const VIRTUALIZE_PROJECTS_AFTER = 8
/** Conservative first-pass card height until ResizeObserver reports the rendered size. */
const PROJECT_ROW_ESTIMATE_PX = 142
/** Matches the short-list `gap-2.5` spacing so both rendering paths align. */
const PROJECT_ROW_GAP_PX = 10
/** Keeps nearby rows mounted to make scrolling feel continuous without a large DOM. */
const PROJECT_LIST_OVERSCAN_PX = 280

/**
 * Chooses the simplest project-list implementation for the current panel size.
 *
 * @param props Panel identity, display copy, workspace items, and acknowledgement callback.
 * @returns A normal list for short collections or a virtual list for long collections.
 */
function ProjectList({
  agentType,
  brand,
  copy,
  items,
  locale,
  onAck,
}: {
  agentType: AgentType
  brand: BrandClass
  copy: UiCopy
  items: AgentWorkspaceItem[]
  locale: Locale
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  if (items.length > VIRTUALIZE_PROJECTS_AFTER) {
    return (
      <VirtualProjectList
        agentType={agentType}
        brand={brand}
        copy={copy}
        items={items}
        locale={locale}
        onAck={onAck}
      />
    )
  }

  return (
    <div className="agent-project-list grid min-h-0 flex-1 content-start gap-2.5 overflow-y-auto pr-1">
      {items.map((item) => (
        <ProjectTile
          key={item.id}
          item={item}
          brand={brand}
          locale={locale}
          copy={copy}
          onAck={() => onAck(agentType, item.workspacePath)}
        />
      ))}
    </div>
  )
}

/**
 * Renders a variable-height virtual project list with measured rows.
 *
 * Initial geometry uses a card-height estimate. ResizeObserver replaces each
 * estimate after mount, stale measurements are removed when projects disappear,
 * and scrollTop is clamped when the total list height shrinks.
 *
 * @param props Panel identity, display copy, workspace items, and acknowledgement callback.
 * @returns A scroll container that mounts only the viewport and overscan rows.
 */
function VirtualProjectList({
  agentType,
  brand,
  copy,
  items,
  locale,
  onAck,
}: {
  agentType: AgentType
  brand: BrandClass
  copy: UiCopy
  items: AgentWorkspaceItem[]
  locale: Locale
  onAck: (agentType: AgentType, workspacePath?: string) => void
}): JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewportHeight, setViewportHeight] = useState(0)
  const [scrollTop, setScrollTop] = useState(0)
  const [measuredSizes, setMeasuredSizes] = useState<Map<string, number>>(() => new Map())
  const keys = useMemo(() => items.map((item) => item.id), [items])
  const layout = useMemo(
    () => buildVirtualListLayout(keys, measuredSizes, PROJECT_ROW_ESTIMATE_PX, PROJECT_ROW_GAP_PX),
    [keys, measuredSizes],
  )
  const range = useMemo(
    () => findVirtualListRange(layout.rows, scrollTop, viewportHeight, PROJECT_LIST_OVERSCAN_PX),
    [layout.rows, scrollTop, viewportHeight],
  )

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const update = (): void => setViewportHeight(viewport.clientHeight)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    // Keep the browser scroll position valid after rows disappear or become shorter.
    const viewport = viewportRef.current
    if (!viewport) return
    const maxScrollTop = Math.max(0, layout.totalSize - viewport.clientHeight)
    if (viewport.scrollTop <= maxScrollTop) return
    viewport.scrollTop = maxScrollTop
    setScrollTop(maxScrollTop)
  }, [layout.totalSize, viewportHeight])

  useEffect(() => {
    // Do not retain measurements for project ids that no longer exist in this panel.
    const liveKeys = new Set(keys)
    setMeasuredSizes((current) => {
      if ([...current.keys()].every((key) => liveKeys.has(key))) return current
      return new Map([...current].filter(([key]) => liveKeys.has(key)))
    })
  }, [keys])

  /** Records a stable rounded row height only when ResizeObserver reports a change. */
  const measureRow = useCallback((key: string, size: number): void => {
    const rounded = Math.ceil(size)
    if (rounded <= 0) return
    setMeasuredSizes((current) => {
      if (current.get(key) === rounded) return current
      const next = new Map(current)
      next.set(key, rounded)
      return next
    })
  }, [])

  const handleScroll = useCallback((event: ReactUIEvent<HTMLDivElement>): void => {
    setScrollTop(event.currentTarget.scrollTop)
  }, [])

  return (
    <div
      ref={viewportRef}
      className="agent-project-list min-h-0 flex-1 overflow-y-auto pr-1"
      onScroll={handleScroll}
    >
      <div className="relative" style={{ height: layout.totalSize }}>
        {layout.rows.slice(range.start, range.end).map((row) => {
          const item = items[row.index]!
          return (
            <MeasuredProjectRow
              key={row.key}
              itemKey={row.key}
              start={row.start}
              onMeasure={measureRow}
            >
              <ProjectTile
                item={item}
                brand={brand}
                locale={locale}
                copy={copy}
                onAck={() => onAck(agentType, item.workspacePath)}
              />
            </MeasuredProjectRow>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Positions one virtual row and reports its rendered height to the parent layout.
 *
 * @param props Row content, stable id, y offset, and measurement callback.
 * @returns An absolutely positioned row wrapper.
 */
function MeasuredProjectRow({
  children,
  itemKey,
  onMeasure,
  start,
}: {
  children: ReactNode
  itemKey: string
  onMeasure: (key: string, size: number) => void
  start: number
}): JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const row = rowRef.current
    if (!row) return
    const measure = (): void => onMeasure(itemKey, row.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [itemKey, onMeasure])

  return (
    <div
      ref={rowRef}
      className="absolute inset-x-0 top-0"
      style={{ transform: `translateY(${start}px)` }}
    >
      {children}
    </div>
  )
}

function AgentLogo({ agentType }: { agentType: AgentType }): JSX.Element {
  if (agentType === 'codex') return <CodexLogo />
  if (agentType === 'grok') return <GrokLogo />
  return <ClaudeLogo />
}

function ClaudeLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Claude Code" className="h-7 w-7">
      <path
        clipRule="evenodd"
        fill="#D97757"
        fillRule="evenodd"
        d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z"
      />
    </svg>
  )
}

function CodexLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Codex" className="h-7 w-7">
      <path
        clipRule="evenodd"
        fill="url(#codexLogoGradient)"
        fillRule="evenodd"
        d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
      />
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id="codexLogoGradient"
          x1="12"
          x2="12"
          y1="0"
          y2="24"
        >
          <stop stopColor="#B1A7FF" />
          <stop offset=".5" stopColor="#7A9DFF" />
          <stop offset="1" stopColor="#3941FF" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function GrokLogo(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" role="img" aria-label="Grok" className="h-7 w-7">
      <path
        fill="currentColor"
        className="text-ink"
        d="M6.227 3.5h3.12l4.38 7.12L18.13 3.5H21.3l-6.02 9.05L21.5 20.5h-3.13l-4.62-7.42-4.63 7.42H6.01l6.24-8.01L6.227 3.5zm-.85 0L12 12.35 5.12 20.5H2.5l6.9-8.19L2.5 3.5h2.877z"
      />
    </svg>
  )
}

const ProjectTile = memo(function ProjectTile({
  item,
  brand,
  locale,
  copy,
  onAck,
}: {
  item: AgentWorkspaceItem
  brand: BrandClass
  locale: Locale
  copy: UiCopy
  onAck: () => void
}): JSX.Element {
  const agent = item.agent
  const style = turnStateStyle(agent.state)
  const token = agent.token
  const contextWindow = effectiveContextWindow(agent)

  return (
    <article className="project-tile px-3.5 py-3">
      <div className="grid gap-2.5">
        <div className="flex min-w-0 items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="project-title-row">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} />
              <h3 className="project-title">{item.name || copy.unknownProject}</h3>
              <span className="project-directory-badge" title={item.workspacePath}>
                {formatProjectDirectoryBadge(item.workspacePath, item.name, copy.pathStatus)}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className={`status-badge ${stateChipClass(agent.state)}`}>
              {turnStateLabel(agent.state, locale)}
            </span>
            {agent.unread && (
              <button
                onClick={onAck}
                className="status-badge border border-emerald-200 bg-emerald-50 text-emerald-700 transition hover:bg-emerald-100 active:translate-y-px"
              >
                {copy.read}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-[minmax(7rem,1fr)_minmax(4.75rem,0.7fr)_minmax(5.5rem,0.7fr)] gap-2">
          <InlineMetric label={copy.model} value={agent.model ?? '—'} />
          <InlineMetric
            label={copy.thinkingDepth}
            value={formatThinkingDepth(agent.reasoningEffort, locale)}
          />
          <InlineMetric
            label={copy.elapsed}
            value={
              <ElapsedTime
                timing={agent.turnTiming}
                legacyStartedAt={agent.turnStartedAt}
                locale={locale}
              />
            }
          />
        </div>

        <ContextMeter brand={brand} token={token} contextWindow={contextWindow} copy={copy} />
      </div>
    </article>
  )
})

function PanelQuotaMeter({
  agentType,
  brand,
  meters,
  locale,
  copy,
}: {
  agentType: AgentType
  brand: BrandClass
  meters: QuotaMeterSource[]
  locale: Locale
  copy: UiCopy
}): JSX.Element {
  const now = useNow()
  const showFiveHour = showsFiveHourQuota(agentType)

  // No quota yet — keep waiting bars so pane layout stays stable.
  // Claude uses 5h + weekly; Codex/Grok only weekly.
  if (meters.length === 0) {
    if (showFiveHour) {
      return (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
          <TokenMeter
            brand={brand}
            label={copy.fiveHourQuota}
            percent={undefined}
            detail={copy.waitingQuota}
          />
          <TokenMeter
            brand={brand}
            label={copy.weeklyQuota}
            percent={undefined}
            detail={copy.waitingQuota}
          />
        </div>
      )
    }
    return (
      <div className="grid grid-cols-1 gap-2">
        <TokenMeter
          brand={brand}
          label={copy.weeklyQuota}
          percent={undefined}
          detail={copy.waitingQuota}
        />
      </div>
    )
  }

  // Claude: one bucket with 5h + weekly side-by-side.
  if (showFiveHour && meters.length === 1) {
    const token = meters[0]!.token
    const { fiveHour, sevenDay } = visibleRateLimitWindows(token, agentType)
    const hasQuota = Boolean(fiveHour ?? sevenDay)
    return (
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2">
        <TokenMeter
          brand={brand}
          label={copy.fiveHourQuota}
          percent={fiveHour?.usedPercent}
          detail={hasQuota ? formatQuotaReset(fiveHour?.resetsAt, now, locale) : copy.waitingQuota}
        />
        <TokenMeter
          brand={brand}
          label={copy.weeklyQuota}
          percent={sevenDay?.usedPercent}
          detail={hasQuota ? formatQuotaReset(sevenDay?.resetsAt, now, locale) : copy.waitingQuota}
        />
      </div>
    )
  }

  // Codex / Grok: weekly bars only. Multiple Codex buckets (default + Spark) stack vertically.
  return (
    <div className="grid grid-cols-1 gap-2">
      {meters.map((meter) => {
        const { sevenDay } = visibleRateLimitWindows(meter.token, agentType)
        const hasQuota = Boolean(sevenDay)
        return (
          <TokenMeter
            key={meter.id}
            brand={brand}
            label={weeklyMeterLabel(meter.token, copy.weeklyQuota)}
            percent={sevenDay?.usedPercent}
            detail={
              hasQuota ? formatQuotaReset(sevenDay?.resetsAt, now, locale) : copy.waitingQuota
            }
          />
        )
      })}
    </div>
  )
}

/**
 * Default Codex weekly → "每周额度"; Spark / named buckets keep the CLI limit name
 * (e.g. GPT-5.3-Codex-Spark) so stacked bars stay distinguishable.
 */
function weeklyMeterLabel(token: TokenPayload | undefined, weeklyQuota: string): string {
  const name = quotaBucketLabel(token)
  if (!name) return weeklyQuota
  const normalized = name.toLowerCase()
  if (normalized === 'codex' || normalized === 'weekly' || normalized.includes('weekly')) {
    return weeklyQuota
  }
  return name
}

function quotaBucketLabel(token: TokenPayload | undefined): string | undefined {
  const label = token?.rateLimitName?.trim() || token?.rateLimitId?.trim()
  if (!label) return undefined
  return label.replace(/^GPT-/i, 'GPT ')
}

function RelativeTime({
  timestamp,
  locale,
}: {
  timestamp: number | undefined
  locale: Locale
}): JSX.Element {
  const now = useNow()
  return <>{timestamp ? formatRelative(timestamp, now, locale) : '—'}</>
}

/**
 * Renders a live task duration from a CLI-native timing snapshot. Active turns
 * advance with the local clock, while completed turns retain their frozen CLI
 * duration after hooks, the renderer, or the desktop app restart.
 *
 * @param props Component properties.
 * @param props.timing Latest normalized CLI turn-timing snapshot.
 * @param props.legacyStartedAt Active start retained for server-version compatibility.
 * @param props.locale Dashboard display locale.
 * @returns The formatted elapsed-time text or an em dash when CLI timing is unknown.
 */
function ElapsedTime({
  timing,
  legacyStartedAt,
  locale,
}: {
  timing: AgentRuntimeState['turnTiming']
  legacyStartedAt: number | undefined
  locale: Locale
}): JSX.Element {
  const now = useNow()
  if (timing?.state === 'active' && timing.startedAt) {
    return <>{formatDuration(now - timing.startedAt, locale)}</>
  }
  if (timing?.state === 'completed' && timing.elapsedMs != null) {
    return <>{formatDuration(timing.elapsedMs, locale)}</>
  }
  if (legacyStartedAt) return <>{formatDuration(now - legacyStartedAt, locale)}</>
  return <>—</>
}

function ContextMeter({
  brand,
  token,
  contextWindow,
  copy,
}: {
  brand: BrandClass
  token: TokenPayload | undefined
  contextWindow: number | undefined
  copy: UiCopy
}): JSX.Element {
  const status = formatContextWindowStatus(token, contextWindow, copy.contextStatus)
  const usedPercent = status.usedPercent
  const hasPercent = typeof usedPercent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, usedPercent))}%` : '0%'

  return (
    <div className="rounded-badge border border-line bg-[#F8FAFC] px-3 py-2">
      <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="shrink-0 font-medium text-ink-500">{copy.contextWindow}</span>
        <span className="truncate font-semibold text-ink">{status.text}</span>
      </div>
      <div className="meter-track">
        <div
          className={`meter-fill ${hasPercent ? meterFillClass(usedPercent, brand) : 'idle'}`}
          style={{ width }}
        />
      </div>
    </div>
  )
}

function TokenMeter({
  brand,
  label,
  percent,
  detail,
}: {
  brand: BrandClass
  label: string
  percent: number | undefined
  detail: string
}): JSX.Element {
  const hasPercent = typeof percent === 'number'
  const width = hasPercent ? `${Math.min(100, Math.max(2, percent))}%` : '0%'

  return (
    <div className="rounded-badge border border-line bg-[#F8FAFC] px-3 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-medium text-ink-500">{label}</span>
        <span className={`font-semibold ${hasPercent ? tokenTextColor(percent) : 'text-ink-400'}`}>
          {formatTokenPercent(percent)}
        </span>
      </div>
      <div className="meter-track">
        <div
          className={`meter-fill ${hasPercent ? meterFillClass(percent, brand) : 'idle'}`}
          style={{ width }}
        />
      </div>
      <p className="mt-1.5 truncate text-[11px] font-medium text-ink-500">{detail}</p>
    </div>
  )
}

function InlineMetric({ label, value }: { label: string; value: ReactNode }): JSX.Element {
  return (
    <div className="stat-pill min-w-0">
      <p className="text-[10px] font-medium text-ink-500">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{value}</p>
    </div>
  )
}

function Metric({
  label,
  value,
  className = '',
}: {
  label: string
  value: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={`stat-pill min-w-0 ${className}`}>
      <p className="text-[10px] text-ink-500">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-ink">{value}</p>
    </div>
  )
}

function effectiveContextWindow(agent: AgentRuntimeState): number | undefined {
  return agent.token?.contextWindow ?? (agent.agentType === 'codex' ? 256_000 : undefined)
}

type BrandClass = 'brand-claude' | 'brand-codex' | 'brand-grok'

function brandClass(agentType: AgentType): BrandClass {
  if (agentType === 'codex') return 'brand-codex'
  if (agentType === 'grok') return 'brand-grok'
  return 'brand-claude'
}

function stateChipClass(state: AgentRuntimeState['state']): string {
  switch (state) {
    case TurnState.DONE:
      return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
    case TurnState.ERROR:
    case TurnState.USAGE_LIMITED:
      return 'bg-red-50 text-red-700 ring-1 ring-red-200'
    case TurnState.WAITING_PERMISSION:
    case TurnState.WAITING_USER_INPUT:
      return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
    case TurnState.TIMEOUT:
      return 'bg-orange-50 text-orange-700 ring-1 ring-orange-200'
    case TurnState.THINKING:
    case TurnState.TOOL_RUNNING:
    case TurnState.PROMPT_SUBMITTED:
      return 'bg-blue-50 text-blue-700 ring-1 ring-blue-200'
    default:
      return 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'
  }
}

/** 设计指引：正常用量用品牌色，≥80% 警告黄，≥95% 危险红。 */
function meterFillClass(pct: number, brand: BrandClass): string {
  if (pct >= 95) return 'danger'
  if (pct >= 80) return 'warn'
  return brand
}

function tokenTextColor(pct: number): string {
  if (pct >= 95) return 'text-red-600'
  if (pct >= 80) return 'text-amber-700'
  return 'text-ink'
}

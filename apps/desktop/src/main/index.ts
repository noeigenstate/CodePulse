import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron'
import {
  type Agent,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
  type UiLocale,
  type UpdateDownloadProgress,
  type UpdateInfo,
  type UpdateInstallResult,
  type UsageStatsQuery,
} from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import {
  openDb,
  persistEvent,
  pruneEventsBefore,
  queryUsageStats,
  type DB,
} from '@codepulse/storage'
import {
  cleanupAgents,
  configureAgents,
  detectAgents,
  startLocalServer,
  type LocalServer,
} from '@codepulse/local-server'
import { TrayController } from './tray.js'
import { showNotification } from './notifications.js'
import { checkForUpdate, downloadInstaller } from './update-checker.js'

const MUTE_DURATION_MS = 30 * 60_000
const DISABLE_UPDATE_CHECK_ENV = 'CODEPULSE_DISABLE_UPDATE_CHECKS'
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60_000
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000
const EVENT_PRUNE_INTERVAL_MS = 24 * 60 * 60_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let server: LocalServer | null = null
let db: DB | null = null
/** 本机 SQLite 路径；统计后台只读此库（与实时 StatusHub 内存态分离）。 */
let dbPath: string | null = null
/** openDb 失败时的原因，用于统计页诊断。 */
let dbOpenError: string | undefined
let muteTimer: NodeJS.Timeout | null = null
let updateTimer: NodeJS.Timeout | null = null
let pruneTimer: NodeJS.Timeout | null = null
let latestUpdate: UpdateInfo | null = null
let checkingUpdate = false
let installingUpdate = false
let lastTrayStatusKey: string | undefined

const hub = new StatusHub()

function broadcast(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    void refreshLocalAgents()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  void refreshLocalAgents()
}

function appIconPath(): string {
  return join(app.getAppPath(), 'build/icon.png')
}

function hookBinDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'codepulse-hooks', 'bin')
  return join(app.getAppPath(), '..', '..', 'packages', 'hooks', 'bin')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    title: 'CodePulse',
    backgroundColor: '#edf6ff',
    icon: appIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function wireHub(): void {
  hub.on('event', (event) => {
    if (!db) return
    try {
      persistEvent(db, event)
    } catch (err) {
      console.error('[codepulse] failed to persist event', err)
    }
  })

  hub.on('status', (snapshot: StatusSnapshot) => {
    updateTrayIfChanged(snapshot)
    broadcast('codepulse:status', snapshot)
  })

  hub.on('notification', (note: NotificationRequest) => {
    showNotification(note, showWindow)
  })
}

function setMuted(muted: boolean): void {
  hub.setMuted(muted)
  tray?.setMuted(muted)
  if (muteTimer) {
    clearTimeout(muteTimer)
    muteTimer = null
  }
  if (muted) {
    muteTimer = setTimeout(() => setMuted(false), MUTE_DURATION_MS)
    muteTimer.unref?.()
  }
  broadcast('codepulse:mute', muted)
}

function setLocale(value: unknown): UiLocale {
  const locale: UiLocale = value === 'en' ? 'en' : 'zh'
  hub.setLocale(locale)
  return locale
}

function registerIpc(): void {
  ipcMain.handle('codepulse:get-status', () => hub.snapshot())
  ipcMain.handle('codepulse:ack', (_event, agent: AgentType, workspacePath?: string) => {
    hub.acknowledge(agent, workspacePath)
    return true
  })
  ipcMain.handle('codepulse:set-mute', (_event, muted: boolean) => {
    setMuted(muted)
    return muted
  })
  ipcMain.handle('codepulse:set-locale', (_event, locale: unknown) => setLocale(locale))
  ipcMain.handle('codepulse:detect-agents', () => refreshLocalAgents())
  ipcMain.handle('codepulse:get-update', () => latestUpdate)
  ipcMain.handle('codepulse:install-update', () => installLatestUpdate())
  ipcMain.handle('codepulse:get-stats', (_event, query?: UsageStatsQuery) =>
    queryUsageStats(db, query ?? {}, Date.now(), {
      dbPath: dbPath ?? undefined,
      openError: dbOpenError,
    }),
  )
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null)

  dbPath = join(app.getPath('userData'), 'codepulse.sqlite')
  try {
    db = openDb(dbPath).db
    dbOpenError = undefined
    console.log(`[codepulse] SQLite ready at ${dbPath}`)
  } catch (err) {
    db = null
    dbOpenError = err instanceof Error ? err.message : String(err)
    console.error('[codepulse] SQLite unavailable - running without persistence', err)
    console.error(
      '[codepulse] Live dashboard still works; local analytics will stay empty until SQLite loads.',
    )
  }

  wireHub()
  registerIpc()

  try {
    server = await startLocalServer({ hub })
    console.log(`[codepulse] local server listening on ${server.url}`)
  } catch (err) {
    console.error('[codepulse] failed to start local server', err)
  }
  await refreshLocalAgents()

  hub.startWatchdog()
  startMaintenanceTimers()

  tray = new TrayController({
    onOpen: showWindow,
    onToggleMute: setMuted,
    onQuit: () => {
      app.quit()
    },
  })

  createWindow()
  void checkForUpdatesOnce()
}

function startMaintenanceTimers(): void {
  prunePersistedEvents()

  if (pruneTimer) clearInterval(pruneTimer)
  pruneTimer = setInterval(prunePersistedEvents, EVENT_PRUNE_INTERVAL_MS)
  pruneTimer.unref?.()

  if (updateTimer) clearInterval(updateTimer)
  updateTimer = setInterval(() => {
    void checkForUpdatesOnce()
  }, UPDATE_CHECK_INTERVAL_MS)
  updateTimer.unref?.()
}

function stopMaintenanceTimers(): void {
  if (pruneTimer) clearInterval(pruneTimer)
  if (updateTimer) clearInterval(updateTimer)
  pruneTimer = null
  updateTimer = null
}

function prunePersistedEvents(): void {
  if (!db) return
  try {
    pruneEventsBefore(db, Date.now() - EVENT_RETENTION_MS)
  } catch (err) {
    console.error('[codepulse] failed to prune old events', err)
  }
}

function updateTrayIfChanged(snapshot: StatusSnapshot): void {
  const key = trayStatusKey(snapshot)
  if (key === lastTrayStatusKey) return
  lastTrayStatusKey = key
  tray?.update(snapshot)
}

async function checkForUpdatesOnce(): Promise<UpdateInfo | null> {
  if (!shouldCheckForUpdates() || checkingUpdate) return latestUpdate
  checkingUpdate = true
  try {
    const update = await checkForUpdate(app.getVersion())
    latestUpdate = update
    if (update) broadcast('codepulse:update-available', update)
    return update
  } catch (err) {
    console.error('[codepulse] failed to check for updates', err)
    return null
  } finally {
    checkingUpdate = false
  }
}

async function installLatestUpdate(): Promise<UpdateInstallResult> {
  if (installingUpdate) return { ok: false, error: 'Update installation is already running.' }
  installingUpdate = true

  try {
    const update = latestUpdate ?? (await checkForUpdatesOnce())
    if (!update) return { ok: false, error: 'No update is available.' }

    if (!update.installable) {
      await shell.openExternal(update.releaseUrl)
      return { ok: true }
    }

    broadcastUpdateProgress({ phase: 'preparing', received: 0, percent: 0 })

    const installerPath = await downloadInstaller(
      update,
      join(app.getPath('temp'), 'CodePulse', 'updates', update.tag),
      (progress) =>
        broadcastUpdateProgress({
          phase: progress.phase ?? 'downloading',
          received: progress.received,
          total: progress.total,
          percent: progress.percent,
        }),
    )

    // Download finished — show install/launch progress before we quit.
    broadcastUpdateProgress({
      phase: 'launching',
      received: 0,
      percent: 100,
    })
    // Give the renderer a beat to paint the install progress bar.
    await sleep(350)

    // Hide the modal window first so Windows UAC / NSIS UI is not covered.
    try {
      mainWindow?.setAlwaysOnTop(false)
      mainWindow?.hide()
    } catch {
      // ignore window hide failures
    }

    // Detached spawn: shell.openPath can block on UAC and leave the UI stuck on
    // "installing". NSIS also waits if CodePulse is still running with locked files.
    launchInstallerDetached(installerPath)

    // Exit ASAP so the installer can replace files; delay only enough for IPC to flush.
    setTimeout(() => {
      app.exit(0)
    }, 200).unref?.()
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[codepulse] failed to install update', err)
    // Restore window if download failed after hide (should only fail before hide).
    try {
      mainWindow?.show()
    } catch {
      // ignore
    }
    // Offer the release page so users can install manually when GitHub is unreachable.
    try {
      const releaseUrl = latestUpdate?.releaseUrl
      if (releaseUrl && /timed out|All download sources failed|ENOTFOUND|ECONN/i.test(message)) {
        await shell.openExternal(releaseUrl)
      }
    } catch {
      // ignore
    }
    return { ok: false, error: message }
  } finally {
    installingUpdate = false
  }
}

function broadcastUpdateProgress(progress: UpdateDownloadProgress): void {
  broadcast('codepulse:update-progress', progress)
}

/**
 * Launch the NSIS installer without waiting for it (or for UAC).
 * Using detached+unref keeps the child alive after CodePulse exits.
 */
export function launchInstallerDetached(installerPath: string): void {
  const child = spawn(installerPath, [], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.unref()
  child.on('error', (err) => {
    console.error('[codepulse] failed to launch installer', err)
  })
}

function shouldCheckForUpdates(): boolean {
  return process.env[DISABLE_UPDATE_CHECK_ENV] !== '1'
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function trayStatusKey(snapshot: StatusSnapshot): string {
  return JSON.stringify({
    overall: snapshot.overall,
    agents: snapshot.agents.filter((agent) => !agent.taskHidden),
  })
}

async function configureLocalAgents(): Promise<void> {
  const result = await configureAgents({ hookBinDir: hookBinDir() })
  for (const [agent, status] of Object.entries(result)) {
    if (status.error) {
      console.error(`[codepulse] failed to configure ${agent}`, status.error)
      continue
    }
    if (status.changed) console.log(`[codepulse] configured ${agent} hooks at ${status.path}`)
  }
}

async function cleanupLocalAgents(): Promise<void> {
  const result = await cleanupAgents({ hookBinDir: hookBinDir() })
  for (const [agent, status] of Object.entries(result)) {
    if (status.error) {
      console.error(`[codepulse] failed to clean ${agent}`, status.error)
      continue
    }
    if (status.changed) console.log(`[codepulse] cleaned ${agent} hooks at ${status.path}`)
  }
}

async function refreshLocalAgents(): Promise<Agent[]> {
  await configureLocalAgents()
  const agents = await detectAgents()
  broadcast('codepulse:agents', agents)
  return agents
}

app.setName('CodePulse')
if (process.platform === 'win32') {
  app.setAppUserModelId('CodePulse')
}

const cleanupMode = process.argv.includes('--cleanup-config')
if (cleanupMode) {
  app
    .whenReady()
    .then(async () => {
      await cleanupLocalAgents()
      app.quit()
    })
    .catch((err) => {
      console.error('[codepulse] cleanup failed', err)
      app.exit(1)
    })
} else if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error('[codepulse] bootstrap failed', err)
    })

  app.on('window-all-closed', () => {
    // Keep running in the system tray.
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    hub.stopWatchdog()
    stopMaintenanceTimers()
    tray?.destroy()
    void server?.close()
  })
}

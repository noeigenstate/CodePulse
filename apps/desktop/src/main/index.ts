import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import {
  type Agent,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
} from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import { openDb, persistEvent, type DB } from '@codepulse/storage'
import {
  cleanupAgents,
  configureAgents,
  detectAgents,
  startLocalServer,
  type LocalServer,
} from '@codepulse/local-server'
import { TrayController } from './tray.js'
import { showNotification } from './notifications.js'

const MUTE_DURATION_MS = 30 * 60_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let server: LocalServer | null = null
let db: DB | null = null
let muteTimer: NodeJS.Timeout | null = null

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
    tray?.update(snapshot)
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
  ipcMain.handle('codepulse:detect-agents', () => refreshLocalAgents())
}

async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null)

  const dbPath = join(app.getPath('userData'), 'codepulse.sqlite')
  try {
    db = openDb(dbPath).db
  } catch (err) {
    db = null
    console.error('[codepulse] SQLite unavailable - running without persistence', err)
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

  tray = new TrayController({
    onOpen: showWindow,
    onToggleMute: setMuted,
    onQuit: () => {
      app.quit()
    },
  })

  createWindow()
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
    tray?.destroy()
    void server?.close()
  })
}

/**
 * Electron main process entry point. Wires together the storage layer, the
 * {@link StatusHub}, the local server, the system tray, desktop notifications,
 * and the Dashboard window, and exposes everything to the renderer over IPC.
 *
 * @module main
 */
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
} from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import { openDb, persistEvent, type DB } from '@codepulse/storage'
import { startLocalServer, type LocalServer } from '@codepulse/local-server'
import { trayIconFor } from './icon.js'
import { TrayController } from './tray.js'
import { showNotification } from './notifications.js'

/** How long the "static mute" lasts before auto-unmuting (requirements §5.6). */
const MUTE_DURATION_MS = 30 * 60_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let server: LocalServer | null = null
let db: DB | null = null
let muteTimer: NodeJS.Timeout | null = null

/** The single, process-wide status hub. */
const hub = new StatusHub()

/**
 * Sends an IPC message to the renderer, if a window exists.
 *
 * @param channel The IPC channel name.
 * @param payload The serializable payload.
 */
function broadcast(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

/**
 * Shows and focuses the main window, creating it if it has been closed.
 */
function showWindow(): void {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * Creates the Dashboard window and loads the renderer (the electron-vite dev
 * server URL in development, the bundled `index.html` in production).
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'CodePulse',
    backgroundColor: '#0b0f17',
    icon: trayIconFor('idle'),
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

/**
 * Subscribes the side-effecting layers (storage, tray, notifications, renderer)
 * to the hub's events.
 */
function wireHub(): void {
  hub.on('event', (event) => {
    if (db) {
      try {
        persistEvent(db, event)
      } catch (err) {
        console.error('[codepulse] failed to persist event', err)
      }
    }
  })

  hub.on('status', (snapshot: StatusSnapshot) => {
    tray?.update(snapshot)
    broadcast('codepulse:status', snapshot)
  })

  hub.on('notification', (note: NotificationRequest) => {
    showNotification(note, showWindow)
    broadcast('codepulse:notification', note)
  })
}

/**
 * Sets the mute state, manages the 30-minute auto-unmute timer, and notifies the
 * tray and renderer.
 *
 * @param muted `true` to mute notification sound, `false` to unmute.
 */
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

/**
 * Registers the IPC handlers the preload bridge exposes to the renderer
 * (get status, acknowledge, mute, clear alerts, server info).
 */
function registerIpc(): void {
  ipcMain.handle('codepulse:get-status', () => hub.snapshot())
  ipcMain.handle('codepulse:ack', (_event, agent: AgentType) => {
    hub.acknowledge(agent)
    return true
  })
  ipcMain.handle('codepulse:set-mute', (_event, muted: boolean) => {
    setMuted(muted)
    return muted
  })
  ipcMain.handle('codepulse:clear-alerts', () => {
    hub.acknowledge('codex')
    hub.acknowledge('claude_code')
    return true
  })
  ipcMain.handle('codepulse:server-info', () => ({
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
  }))
}

/**
 * Application bootstrap, run once Electron is ready.
 *
 * Opens the database (degrading gracefully if the native module is missing),
 * wires the hub, registers IPC, starts the local server and inactivity
 * watchdog, creates the tray, and opens the window.
 */
async function bootstrap(): Promise<void> {
  const dbPath = join(app.getPath('userData'), 'codepulse.sqlite')
  try {
    db = openDb(dbPath).db
  } catch (err) {
    // The native better-sqlite3 addon may be missing/ABI-mismatched (e.g. the
    // Electron rebuild step did not run). Degrade gracefully: the live status
    // hub still works, only session history persistence is disabled.
    db = null
    console.error('[codepulse] SQLite unavailable — running without persistence', err)
  }

  wireHub()
  registerIpc()

  try {
    server = await startLocalServer({ hub })
    console.log(`[codepulse] local server listening on ${server.url}`)
  } catch (err) {
    console.error('[codepulse] failed to start local server', err)
  }

  hub.startWatchdog()

  tray = new TrayController({
    onOpen: showWindow,
    onOpenSettings: () => {
      showWindow()
      broadcast('codepulse:navigate', 'settings')
    },
    onToggleMute: setMuted,
    onClearAlerts: () => {
      hub.acknowledge('codex')
      hub.acknowledge('claude_code')
    },
    onQuit: () => {
      app.quit()
    },
  })

  createWindow()
}

// Pin the app name so the userData directory (where the SQLite DB lives) is
// stable across dev and packaged builds: %APPDATA%\CodePulse on Windows.
app.setName('CodePulse')

// Enforce a single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('[codepulse] bootstrap failed', err)
  })

  // Keep running in the tray when all windows are closed.
  app.on('window-all-closed', () => {
    // Intentionally do not quit — CodePulse lives in the tray.
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

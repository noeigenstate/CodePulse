/**
 * Electron 主进程入口。把存储层、{@link StatusHub}、本地服务器、
 * 系统托盘、桌面通知与 Dashboard 窗口串联起来，
 * 并通过 IPC 全部暴露给渲染进程。
 *
 * @module main
 */
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, Menu } from 'electron'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
} from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import { openDb, persistEvent, type DB } from '@codepulse/storage'
import { detectAgents, startLocalServer, type LocalServer } from '@codepulse/local-server'
import { TrayController } from './tray.js'
import { showNotification } from './notifications.js'
import { startCodexUsagePoller } from './codex-usage-poller.js'

/** 「静音」持续多久后自动取消（需求 §5.6）。 */
const MUTE_DURATION_MS = 30 * 60_000

let mainWindow: BrowserWindow | null = null
let tray: TrayController | null = null
let server: LocalServer | null = null
let db: DB | null = null
let muteTimer: NodeJS.Timeout | null = null
let stopCodexUsagePoller: (() => void) | null = null

/** 进程级唯一的状态 hub。 */
const hub = new StatusHub()

/**
 * 若窗口存在，向渲染进程发送 IPC 消息。
 *
 * @param channel IPC 通道名。
 * @param payload 可序列化的载荷。
 */
function broadcast(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

/**
 * 显示并聚焦主窗口；若已关闭则重新创建。
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
 * 解析 BrowserWindow 外观使用的应用图标。同一图片也在
 * electron-builder 中配置为打包后的应用图标。
 *
 * @returns 图标图片的绝对路径。
 */
function appIconPath(): string {
  return join(app.getAppPath(), 'build/icon.png')
}

/**
 * 创建 Dashboard 窗口并加载渲染端（开发环境为 electron-vite
 * 开发服务器 URL，生产环境为打包的 `index.html`）。
 */
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

/**
 * 把产生副作用的各层（存储、托盘、通知、渲染端）订阅到 hub 的事件上。
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
 * 设置静音状态，管理 30 分钟自动取消静音的定时器，
 * 并通知托盘与渲染端。
 *
 * @param muted `true` 静音通知声音，`false` 取消静音。
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
 * 注册 preload 桥暴露给渲染端的 IPC 处理器
 * （获取状态、确认、静音、清除提醒、服务器信息）。
 */
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
  ipcMain.handle('codepulse:clear-alerts', () => {
    hub.acknowledge('codex')
    hub.acknowledge('claude_code')
    return true
  })
  ipcMain.handle('codepulse:server-info', () => ({
    host: DEFAULT_SERVER_HOST,
    port: DEFAULT_SERVER_PORT,
  }))
  ipcMain.handle('codepulse:detect-agents', () => detectAgents())
}

/**
 * 应用引导逻辑，在 Electron 就绪后执行一次。
 *
 * 打开数据库（原生模块缺失时优雅降级）、接线 hub、注册 IPC、
 * 启动本地服务器与无活动看门狗、创建托盘并打开窗口。
 */
async function bootstrap(): Promise<void> {
  Menu.setApplicationMenu(null)

  const dbPath = join(app.getPath('userData'), 'codepulse.sqlite')
  try {
    db = openDb(dbPath).db
  } catch (err) {
    // 原生 better-sqlite3 扩展可能缺失或 ABI 不匹配（例如未执行
    // Electron rebuild）。优雅降级：实时状态 hub 仍然工作，
    // 只是会话历史持久化被禁用。
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
  stopCodexUsagePoller = startCodexUsagePoller(hub)

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

// 固定应用名，使 userData 目录（SQLite 数据库所在地）在开发与
// 打包构建之间保持稳定：Windows 上为 %APPDATA%\CodePulse。
app.setName('CodePulse')

// 强制单实例：第二次启动会聚焦现有窗口。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)

  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      console.error('[codepulse] bootstrap failed', err)
    })

  // 所有窗口关闭后继续在托盘中运行。
  app.on('window-all-closed', () => {
    // 故意不退出 —— CodePulse 常驻托盘。
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  app.on('before-quit', () => {
    hub.stopWatchdog()
    stopCodexUsagePoller?.()
    tray?.destroy()
    void server?.close()
  })
}

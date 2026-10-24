import { BrowserWindow } from 'electron'
import type { WorkbenchWindowState } from '@codepulse/shared'
import { scheduledWindowTheme, windowChromePalette } from './window-chrome.js'

/** A presentation window only: the host owns every collector and device connection. */
export class ScreenWorkbenchWindow {
  private window: BrowserWindow | null = null
  constructor(
    private paths: { preload: string; renderer: string; icon: string; devUrl?: string },
  ) {}
  owns(id: number): boolean {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.webContents.id === id)
  }
  broadcast(channel: string, value: unknown): void {
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send(channel, value)
  }
  state(): WorkbenchWindowState {
    return {
      pinned: this.window?.isAlwaysOnTop() ?? false,
      fullscreen: this.window?.isFullScreen() ?? false,
    }
  }
  configure(id: number, input: unknown): WorkbenchWindowState {
    if (!this.owns(id) || !input || typeof input !== 'object')
      throw new Error('Only the screen window can change its presentation')
    const patch = input as Record<string, unknown>
    if (
      Object.entries(patch).some(
        ([key, value]) => !['pinned', 'fullscreen'].includes(key) || typeof value !== 'boolean',
      )
    )
      throw new Error('Invalid screen window settings')
    if (typeof patch.pinned === 'boolean') this.window!.setAlwaysOnTop(patch.pinned)
    if (typeof patch.fullscreen === 'boolean') this.window!.setFullScreen(patch.fullscreen)
    const next = this.state()
    this.broadcast('codepulse:workbench-window', next)
    return next
  }
  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show()
      this.window.focus()
      return
    }
    const window = new BrowserWindow({
      width: 980,
      height: 820,
      minWidth: 640,
      minHeight: 500,
      show: false,
      autoHideMenuBar: true,
      title: 'CodePulse · 屏幕工作台',
      icon: this.paths.icon,
      backgroundColor: windowChromePalette(scheduledWindowTheme()).backgroundColor,
      webPreferences: {
        preload: this.paths.preload,
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.window = window
    window.on('page-title-updated', event => event.preventDefault())
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && window.isFullScreen()) {
        event.preventDefault()
        window.setFullScreen(false)
      }
    })
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      this.window = null
    })
    const changed = () => this.broadcast('codepulse:workbench-window', this.state())
    window.on('enter-full-screen', changed)
    window.on('leave-full-screen', changed)
    window.on('always-on-top-changed', changed)
    window.webContents.on('render-process-gone', (_event, detail) => {
      if (detail.reason !== 'clean-exit' && !window.isDestroyed()) window.webContents.reload()
    })
    if (this.paths.devUrl) {
      const url = new URL(this.paths.devUrl)
      url.searchParams.set('surface', 'screen')
      void window.loadURL(url.toString())
    } else void window.loadFile(this.paths.renderer, { query: { surface: 'screen' } })
  }
  destroy(): void {
    this.window?.destroy()
    this.window = null
  }
}

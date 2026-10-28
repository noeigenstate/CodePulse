import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrowserWindow, ipcMain, screen, type WebContents, type Rectangle } from 'electron'
import type { StatusHub } from '@codepulse/core'
import type { Agent, HudAppearanceSettings, StatusSnapshot } from '@codepulse/shared'
import { normalizeWindowTheme, windowChromePalette, type WindowTheme } from './window-chrome.js'
import { HUD_AGENT_TYPES, HudProjection } from './hud-projection.js'
import {
  HUD_WINDOW_SHELL_OPTIONS,
  HUD_WINDOW_MIN_SIZE,
  applyHudWindowTheme,
  hudContentHeightForDisplay,
  hudWindowBoundsForDisplay,
  hudWindowBoundsForReveal,
} from './hud-window.js'

/** Hosts the existing HUD build in the same Electron process as the full desktop console. */
export class HudSurface {
  private visible = false
  private window: BrowserWindow | null = null
  private settings: BrowserWindow | null = null
  private projection: HudProjection
  private theme: WindowTheme = 'light'
  private renderer: string
  private preload: string
  private latestSettings?: HudAppearanceSettings

  constructor(
    private hub: StatusHub,
    root: string,
    workspaceBindingsPath?: string,
    private visibilityChanged: () => void = () => {},
    private workChanged: () => void = () => {},
  ) {
    this.projection = new HudProjection(workspaceBindingsPath, () => {
      console.warn(
        '[codepulse] HUD project bindings could not be saved; keeping in-memory bindings',
      )
    })
    this.hub.setPresentationRetention((agent, now) => this.projection.shouldRetain(agent, now))
    this.renderer = resolve(root, 'renderer/index.html')
    this.preload = resolve(root, 'preload/index.js')
    if (!existsSync(this.renderer) || !existsSync(this.preload)) {
      throw new Error('Build the HUD frontend before starting the unified desktop.')
    }
  }

  owns(contents: WebContents): boolean {
    return [this.window, this.settings].some((window) => window?.webContents.id === contents.id)
  }

  snapshot(): StatusSnapshot {
    return this.projection.snapshot(this.hub.snapshotForPresentation())
  }

  acknowledge(type: unknown, workspace?: string, session?: string): void {
    this.hub.acknowledgeRows(
      this.projection.rowsForCard(this.hub.snapshotForPresentation(), type, workspace, session),
    )
  }

  agents(agents: Agent[]): Agent[] {
    return agents.filter((agent) => HUD_AGENT_TYPES.has(agent.type))
  }

  broadcast(channel: string, payload: unknown): void {
    const targets = [this.window, this.settings].filter((window) => window && !window.isDestroyed())
    // Bootstrap replays historical execution cwd before native metadata has
    // hydrated. Bind only when a surface actually observes the current state.
    if (!targets.length) return
    const value =
      channel === 'codepulse:status'
        ? this.snapshot()
        : channel === 'codepulse:agents'
          ? this.agents(payload as Agent[])
          : payload
    for (const window of targets) window!.webContents.send(channel, value)
  }

  setTheme(contents: WebContents, value: unknown): WindowTheme {
    this.theme = normalizeWindowTheme(value)
    const target = BrowserWindow.fromWebContents(contents)
    if (target === this.window) applyHudWindowTheme(this.theme, target)
    else target?.setBackgroundColor(windowChromePalette(this.theme).backgroundColor)
    return this.theme
  }

  registerIpc(): void {
    ipcMain.handle('codepulse:set-hud-content-height', (event, height: unknown) => {
      const window = this.window
      if (
        !window ||
        window.webContents.id !== event.sender.id ||
        typeof height !== 'number' ||
        !Number.isFinite(height)
      )
        return false
      const display = screen.getDisplayMatching(window.getBounds())
      window.setBounds(
        {
          ...window.getBounds(),
          width: hudWindowBoundsForDisplay(display).width,
          height: hudContentHeightForDisplay(height, display),
        },
        false,
      )
      return true
    })
    ipcMain.handle('codepulse:open-settings-window', () => {
      this.openSettings()
      return true
    })
    ipcMain.handle(
      'codepulse:dismiss-project-card',
      (_event, type: unknown, workspace?: string, session?: string) => {
        const changed = this.projection.dismiss(
          this.hub.snapshotForPresentation(), type, workspace, session,
        )
        this.broadcast('codepulse:status', this.hub.snapshot())
        if (changed) this.workChanged()
        return changed
      },
    )
    ipcMain.handle('codepulse:set-result-retention', (_event, minutes: unknown) => {
      const changed = this.projection.setRetention(minutes)
      if (changed) { this.broadcast('codepulse:status', this.hub.snapshot()); this.workChanged() }
      return changed
    })
    ipcMain.handle('codepulse:set-mute', (_event, value: unknown) => {
      // HUD mute is a presentation preference; desktop notifications have their own explicit setting.
      const muted = value === true
      this.broadcast('codepulse:mute', muted)
      return muted
    })
  }

  isVisible(): boolean { return !!this.window && !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized() }
  hide(): void { this.visible = false; this.window?.hide(); this.visibilityChanged() }

  syncSettings(settings: HudAppearanceSettings): void {
    this.latestSettings = settings
    if (this.projection.setRetention(settings.resultRetentionMinutes)) {
      this.broadcast('codepulse:status', this.hub.snapshot())
      this.workChanged()
    }
    const targets = [this.window, this.settings].filter((w) => w && !w.isDestroyed())
    if (!targets.length) return
    const payload = JSON.stringify({
      schemaVersion: 3,
      ...settings,
    })
    const script = `try{window.localStorage.setItem('codepulse:dashboard-settings',${JSON.stringify(payload)});window.dispatchEvent(new StorageEvent('storage',{key:'codepulse:dashboard-settings'}));}catch{}`
    for (const win of targets) {
      void win!.webContents.executeJavaScript(script).catch(() => {})
    }
  }

  open(anchor?: Rectangle): void {
    this.visible = true
    // This is an explicit user action in Control, not a passive task notification.
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()
    const reveal = (window: BrowserWindow) => {
      if (!this.visible || window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.setBounds(hudWindowBoundsForReveal(display, window.getBounds()), false)
      window.show()
      window.focus()
      this.visibilityChanged()
    }
    if (this.window && !this.window.isDestroyed()) {
      if (this.latestSettings) this.syncSettings(this.latestSettings)
      reveal(this.window)
      return
    }
    const window = new BrowserWindow({
      ...hudWindowBoundsForDisplay(display),
      ...HUD_WINDOW_SHELL_OPTIONS,
      minWidth: HUD_WINDOW_MIN_SIZE.width,
      minHeight: HUD_WINDOW_MIN_SIZE.height,
      show: false,
      autoHideMenuBar: true,
      title: 'CodePulse HUD',
      webPreferences: {
        preload: this.preload,
        partition: 'persist:codepulse-hud-surface',
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.window = window
    this.visibilityChanged()
    window.webContents.on('did-finish-load', () => {
      if (this.latestSettings) this.syncSettings(this.latestSettings)
    })
    // Show only after the renderer is loaded. Do not report the constructor as a visible HUD.
    const notifyVisibility = () => this.visibilityChanged()
    window.on('show', notifyVisibility)
    window.on('hide', notifyVisibility)
    window.on('minimize', notifyVisibility)
    window.on('restore', notifyVisibility)
    window.on('closed', () => {
      this.window = null
      this.visible = false
      this.visibilityChanged()
    })
    void window.loadFile(this.renderer).then(() => {
      reveal(window)
      console.log('[codepulse] HUD shown on client display', display.id, window.getBounds())
    }).catch(error => {
      console.error('[codepulse] HUD renderer failed to load', error)
      if (!window.isDestroyed()) window.destroy()
    })
  }

  private openSettings(): void {
    if (this.settings && !this.settings.isDestroyed()) {
      this.settings.show()
      this.settings.focus()
      return
    }
    const window = new BrowserWindow({
      width: 720,
      height: 760,
      minWidth: 560,
      minHeight: 560,
      show: false,
      title: 'CodePulse HUD 设置',
      autoHideMenuBar: true,
      backgroundColor: windowChromePalette(this.theme).backgroundColor,
      webPreferences: {
        preload: this.preload,
        partition: 'persist:codepulse-hud-surface',
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this.settings = window
    window.once('ready-to-show', () => window.show())
    window.on('closed', () => {
      this.settings = null
    })
    void window.loadFile(this.renderer, { query: { surface: 'settings' } })
  }
}

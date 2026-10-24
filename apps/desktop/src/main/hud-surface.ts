import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrowserWindow, ipcMain, screen, type WebContents } from 'electron'
import type { StatusHub } from '@codepulse/core'
import type { Agent, StatusSnapshot } from '@codepulse/shared'
import { normalizeWindowTheme, windowChromePalette, type WindowTheme } from './window-chrome.js'
import { HUD_AGENT_TYPES, HudProjection } from './hud-projection.js'
import {
  HUD_WINDOW_SHELL_OPTIONS,
  HUD_WINDOW_MIN_SIZE,
  applyHudWindowTheme,
  hudContentHeightForDisplay,
  hudWindowBoundsForDisplay,
  selectHudDisplay,
} from './hud-window.js'

/** Hosts the existing HUD build in the same Electron process as the full desktop console. */
export class HudSurface {
  private window: BrowserWindow | null = null
  private settings: BrowserWindow | null = null
  private projection: HudProjection
  private theme: WindowTheme = 'light'
  private renderer: string
  private preload: string

  constructor(
    private hub: StatusHub,
    root: string,
    workspaceBindingsPath?: string,
  ) {
    this.projection = new HudProjection(workspaceBindingsPath, () => {
      console.warn(
        '[codepulse] HUD project bindings could not be saved; keeping in-memory bindings',
      )
    })
    this.hub.setPresentationRetention((agent, now) => this.projection.shouldRetain(agent, now))
    this.renderer = resolve(root, 'out/renderer/index.html')
    this.preload = resolve(root, 'out/preload/index.js')
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
        return changed
      },
    )
    ipcMain.handle('codepulse:set-result-retention', (_event, minutes: unknown) => {
      const changed = this.projection.setRetention(minutes)
      if (changed) this.broadcast('codepulse:status', this.hub.snapshot())
      return changed
    })
    ipcMain.handle('codepulse:set-mute', (_event, value: unknown) => {
      // HUD mute is a presentation preference; desktop notifications have their own explicit setting.
      const muted = value === true
      this.broadcast('codepulse:mute', muted)
      return muted
    })
  }

  open(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.showInactive()
      return
    }
    const primary = screen.getPrimaryDisplay()
    const display = selectHudDisplay(screen.getAllDisplays(), primary.id) ?? primary
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
    window.once('ready-to-show', () => window.showInactive())
    window.on('closed', () => {
      this.window = null
    })
    void window.loadFile(this.renderer)
    console.log('[codepulse] HUD surface opened; sharing the desktop StatusHub and device service')
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

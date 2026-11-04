import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { BrowserWindow, ipcMain, screen, type WebContents, type Rectangle } from 'electron'
import type { StatusHub } from '@codepulse/core'
import {
  DEFAULT_HUD_SETTINGS,
  type Agent,
  type HudAppearanceSettings,
  type HudOrbPosition,
  type HudStageInfo,
  type StatusSnapshot,
} from '@codepulse/shared'
import { normalizeWindowTheme, windowChromePalette, type WindowTheme } from './window-chrome.js'
import { HUD_AGENT_TYPES, HudProjection } from './hud-projection.js'
import {
  HUD_WINDOW_SHELL_OPTIONS,
  HUD_WINDOW_MIN_SIZE,
  applyHudWindowTheme,
  clampHudOrbPosition,
  hudAlertKeys,
  hudContentHeightForDisplay,
  hudOrbPositionForStage,
  hudStageForStyle,
  hudWindowBoundsForDisplay,
  hudWindowBoundsForReveal,
  showHudInactive,
  type HudDisplay,
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
  private latestSettings: HudAppearanceSettings = DEFAULT_HUD_SETTINGS
  private stage: HudStageInfo = { style: 'panel', anchorH: 'right', anchorV: 'top' }
  private ignoringMouse = false
  private panelBounds?: Rectangle
  private loaded = false
  private revealRequest?: { display: HudDisplay; focus: boolean }
  private drag?: { offset: HudOrbPosition; size: { width: number; height: number } }
  private alertsSeeded = false
  private seenAlerts = new Map<string, number>()

  constructor(
    private hub: StatusHub,
    root: string,
    workspaceBindingsPath?: string,
    private visibilityChanged: () => void = () => {},
    private workChanged: () => void = () => {},
    private orbMoved: (position: HudOrbPosition) => void = () => {},
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
    if (channel === 'codepulse:status') this.observeAlerts()
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
    ipcMain.handle('codepulse:hud-stage-get', () => ({ ...this.stage }))
    ipcMain.handle('codepulse:set-hud-interactive', (event, interactive: unknown) => {
      if (
        !this.isHudSender(event.sender) ||
        this.stage.style === 'panel' ||
        typeof interactive !== 'boolean'
      )
        return false
      this.setInteractive(interactive)
      return true
    })
    ipcMain.handle('codepulse:hud-drag', (event, phase: unknown) => {
      if (!this.isHudSender(event.sender) || this.stage.style !== 'orb') return false
      return this.dragOrb(phase)
    })
    ipcMain.handle('codepulse:set-hud-content-height', (event, height: unknown) => {
      const window = this.window
      if (
        !window ||
        window.isDestroyed() ||
        this.stage.style !== 'panel' ||
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
          this.hub.snapshotForPresentation(),
          type,
          workspace,
          session,
        )
        this.broadcast('codepulse:status', this.hub.snapshot())
        if (changed) this.workChanged()
        return changed
      },
    )
    ipcMain.handle('codepulse:set-result-retention', (_event, minutes: unknown) => {
      const changed = this.projection.setRetention(minutes)
      if (changed) {
        this.broadcast('codepulse:status', this.hub.snapshot())
        this.workChanged()
      }
      return changed
    })
    ipcMain.handle('codepulse:set-mute', (_event, value: unknown) => {
      // HUD mute is a presentation preference; desktop notifications have their own explicit setting.
      const muted = value === true
      this.broadcast('codepulse:mute', muted)
      return muted
    })
  }

  isVisible(): boolean {
    return (
      !!this.window &&
      !this.window.isDestroyed() &&
      this.window.isVisible() &&
      !this.window.isMinimized()
    )
  }
  hide(): void {
    this.visible = false
    this.drag = undefined
    this.setInteractive(false)
    this.window?.hide()
    this.visibilityChanged()
  }

  syncSettings(settings: HudAppearanceSettings): void {
    const previous = this.latestSettings
    this.latestSettings = settings
    const styleChanged = previous.hudStyle !== settings.hudStyle
    const positionChanged =
      previous.orbPosition?.x !== settings.orbPosition?.x ||
      previous.orbPosition?.y !== settings.orbPosition?.y
    if (styleChanged || (settings.hudStyle === 'orb' && positionChanged)) {
      const window = this.window
      if (window && !window.isDestroyed()) {
        if (previous.hudStyle === 'panel') this.panelBounds = window.getBounds()
        this.drag = undefined
        const display =
          settings.hudStyle === 'panel' && this.panelBounds
            ? screen.getDisplayMatching(this.panelBounds)
            : this.windowDisplay()
        this.applyLayout(display, this.panelBounds, true)
      } else {
        this.stage = this.layout(screen.getPrimaryDisplay()).stage
      }
    }
    if (
      previous.resultRetentionMinutes !== settings.resultRetentionMinutes &&
      this.projection.setRetention(settings.resultRetentionMinutes)
    ) {
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
    // This is an explicit user action in Control, not a passive task notification.
    const display = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay()
    this.show(display, true)
  }

  reveal(): void {
    this.show(this.windowDisplay(), false)
  }

  debugState(): { style: HudStageInfo['style']; ignoringMouse: boolean; stage: HudStageInfo } {
    return { style: this.stage.style, ignoringMouse: this.ignoringMouse, stage: { ...this.stage } }
  }

  private show(display: HudDisplay, focus: boolean): void {
    this.visible = true
    this.revealRequest = { display, focus }
    if (this.window && !this.window.isDestroyed()) {
      this.syncSettings(this.latestSettings)
      this.present()
      return
    }
    const layout = this.layout(display, this.panelBounds)
    this.stage = layout.stage
    this.loaded = false
    const window = new BrowserWindow({
      ...layout.bounds,
      ...HUD_WINDOW_SHELL_OPTIONS,
      minWidth: this.stage.style === 'panel' ? HUD_WINDOW_MIN_SIZE.width : 1,
      minHeight: this.stage.style === 'panel' ? HUD_WINDOW_MIN_SIZE.height : 1,
      resizable: this.stage.style === 'panel',
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
    this.setInteractive(false)
    this.visibilityChanged()
    window.webContents.on('did-finish-load', () => {
      if (this.window !== window || window.isDestroyed()) return
      this.loaded = true
      this.syncSettings(this.latestSettings)
      this.sendStage()
      this.present()
    })
    // Show only after the renderer is loaded. Do not report the constructor as a visible HUD.
    const notifyVisibility = () => this.visibilityChanged()
    window.on('show', notifyVisibility)
    window.on('hide', () => {
      this.visible = false
      notifyVisibility()
    })
    window.on('minimize', notifyVisibility)
    window.on('restore', notifyVisibility)
    window.on('closed', () => {
      if (this.window !== window) return
      this.window = null
      this.visible = false
      this.loaded = false
      this.ignoringMouse = false
      this.drag = undefined
      this.visibilityChanged()
    })
    void window.loadFile(this.renderer).catch((error) => {
      console.error('[codepulse] HUD renderer failed to load', error)
      if (!window.isDestroyed()) window.destroy()
    })
  }

  private present(): void {
    const window = this.window
    const request = this.revealRequest
    if (!this.visible || !this.loaded || !window || window.isDestroyed() || !request) return
    this.applyLayout(request.display, this.stage.style === 'panel' ? window.getBounds() : undefined)
    if (request.focus) {
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
    } else {
      showHudInactive(window)
    }
    this.visibilityChanged()
  }

  private layout(display: HudDisplay, panelBounds?: Rectangle) {
    const { hudStyle, orbPosition } = this.latestSettings
    if (hudStyle === 'orb' && orbPosition) {
      const orbDisplay = screen
        .getAllDisplays()
        .find(
          ({ bounds }) =>
            orbPosition.x >= bounds.x &&
            orbPosition.x < bounds.x + bounds.width &&
            orbPosition.y >= bounds.y &&
            orbPosition.y < bounds.y + bounds.height,
        )
      return hudStageForStyle('orb', orbDisplay ?? display, orbDisplay ? orbPosition : undefined)
    }
    const layout = hudStageForStyle(hudStyle, display)
    if (hudStyle === 'panel' && panelBounds) {
      layout.bounds = hudWindowBoundsForReveal(display, panelBounds)
    }
    return layout
  }

  private windowDisplay(): HudDisplay {
    const window = this.window
    if (!window || window.isDestroyed()) return screen.getPrimaryDisplay()
    if (this.stage.style === 'orb') {
      return screen.getDisplayNearestPoint(hudOrbPositionForStage(window.getBounds(), this.stage))
    }
    return screen.getDisplayMatching(window.getBounds())
  }

  private applyLayout(display: HudDisplay, panelBounds?: Rectangle, publishStage = false): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    const layout = this.layout(display, panelBounds)
    const changed = JSON.stringify(this.stage) !== JSON.stringify(layout.stage)
    this.stage = layout.stage
    const panel = this.stage.style === 'panel'
    window.setResizable(panel)
    window.setMinimumSize(
      panel ? HUD_WINDOW_MIN_SIZE.width : 1,
      panel ? HUD_WINDOW_MIN_SIZE.height : 1,
    )
    if (changed || publishStage) this.sendStage()
    window.setBounds(layout.bounds, false)
    this.setInteractive(false)
  }

  private sendStage(): void {
    if (this.loaded && this.window && !this.window.isDestroyed())
      this.window.webContents.send('codepulse:hud-stage', { ...this.stage })
  }

  private isHudSender(contents: WebContents): boolean {
    return !!this.window && !this.window.isDestroyed() && this.window.webContents.id === contents.id
  }

  private setInteractive(interactive: boolean): void {
    const window = this.window
    if (!window || window.isDestroyed()) return
    // Linux cannot forward mouse moves, so compact stages must remain interactive there.
    const ignore =
      this.stage.style !== 'panel' && process.platform !== 'linux' && !this.drag && !interactive
    if (ignore === this.ignoringMouse) return
    window.setIgnoreMouseEvents(ignore, { forward: true })
    this.ignoringMouse = ignore
  }

  private dragOrb(phase: unknown): boolean {
    const window = this.window!
    if (phase === 'start') {
      if (this.drag) return false
      const cursor = screen.getCursorScreenPoint()
      const position = hudOrbPositionForStage(window.getBounds(), this.stage)
      const { width, height } = hudStageForStyle('orb', this.windowDisplay(), position).bounds
      this.drag = {
        offset: { x: cursor.x - position.x, y: cursor.y - position.y },
        size: { width, height },
      }
      this.setInteractive(true)
      return true
    }
    if (!this.drag || (phase !== 'move' && phase !== 'end')) return false
    // Read again on end: the last pointermove need not have reached the renderer.
    const cursor = screen.getCursorScreenPoint()
    const requested = { x: cursor.x - this.drag.offset.x, y: cursor.y - this.drag.offset.y }
    const display = screen.getDisplayNearestPoint(requested)
    const position = clampHudOrbPosition(requested, display)
    const bounds = window.getBounds()
    if (phase === 'move') {
      const offset = hudOrbPositionForStage({ ...bounds, x: 0, y: 0 }, this.stage)
      // Reusing rounded native bounds can accumulate a pixel on every move at fractional DPI.
      window.setBounds(
        { ...this.drag.size, x: position.x - offset.x, y: position.y - offset.y },
        false,
      )
    } else {
      const layout = hudStageForStyle('orb', display, position)
      this.stage = layout.stage
      this.sendStage()
      window.setBounds(layout.bounds, false)
      this.drag = undefined
      this.latestSettings = { ...this.latestSettings, orbPosition: position }
      this.orbMoved(position)
    }
    return true
  }

  private observeAlerts(): void {
    const now = Date.now()
    const keys = hudAlertKeys(
      this.hub.snapshotForPresentation().agents,
      this.latestSettings.visibleTools,
      now,
    )
    for (const [key, seenAt] of this.seenAlerts)
      if (now - seenAt > 60_000) this.seenAlerts.delete(key)
    let added = false
    for (const key of keys) {
      if (this.seenAlerts.has(key)) continue
      this.seenAlerts.set(key, now)
      added = true
    }
    const seeded = this.alertsSeeded
    this.alertsSeeded = true
    if (
      seeded &&
      added &&
      this.latestSettings.autoReveal &&
      !this.isVisible() &&
      !(this.visible && !this.loaded)
    )
      this.reveal()
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

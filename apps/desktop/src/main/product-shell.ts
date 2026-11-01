import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import {
  isProductView,
  canonicalProductView, targetForProductView, productTargets, PRESENTATION_TARGETS,
  normalizeShellPreferences,
  normalizeInkPlan,
  normalizeHudSettings,
  type ShellPreferences,
  type ShellSnapshot,
  type PresentationTarget,
  type HudAppearanceSettings,
} from '@codepulse/shared'

export interface ShellWindows {
  hudAvailable: () => boolean
  hudVisible?: () => boolean
  standard: () => void
  hud: () => void
  screen: () => void
  hideStandard: () => void
  hideHud: () => void
  focusMode?: (focus: boolean) => void
  hudSettingsChanged?: (settings: HudAppearanceSettings) => void
}
/** Window selection has no access to agent, account, device or content state. */
export class ProductShell {
  private preferences: ShellPreferences
  constructor(
    input: unknown,
    private save: (value: ShellPreferences) => void,
    private windows: ShellWindows,
    private changed: (state: ShellSnapshot) => void,
  ) {
    this.preferences = normalizeShellPreferences(input)
  }
  snapshot(): ShellSnapshot {
    return { ...this.preferences, hudAvailable: this.windows.hudAvailable(), hudVisible: this.windows.hudVisible?.() ?? false }
  }
  refresh(): void { this.changed(this.snapshot()) }
  private commit(patch: Partial<ShellPreferences>) {
    const next = { ...this.preferences, ...patch }
    this.save(next)
    this.preferences = next
    this.changed(this.snapshot())
  }
  navigate(view: unknown): ShellSnapshot {
    if (!isProductView(view)) throw new Error('Unknown product view')
    const target = view === 'screen' ? 'ink' : targetForProductView(view, this.preferences.target)
    this.commit({ view: canonicalProductView(view), target, focusMode: false })
    this.windows.focusMode?.(false)
    return this.snapshot()
  }
  selectTarget(target: unknown): ShellSnapshot {
    if (!PRESENTATION_TARGETS.includes(target as PresentationTarget) ||
        !productTargets(this.preferences.view).includes(target as PresentationTarget)) throw new Error('Unsupported presentation target')
    if (target !== this.preferences.target) this.commit({ target: target as PresentationTarget })
    return this.snapshot()
  }
  setFocusMode(focus: unknown): ShellSnapshot {
    if (typeof focus !== 'boolean') throw new Error('Invalid focus mode')
    this.commit({ focusMode: focus, ...(!focus ? { view: 'control' as const } : {}) })
    this.windows.focusMode?.(focus)
    return this.snapshot()
  }
  setDesktopLayout(layout: unknown): ShellSnapshot {
    if (layout !== 'work' && layout !== 'usage' && layout !== 'board') throw new Error('Invalid desktop layout')
    this.commit({ desktopLayout: layout })
    return this.snapshot()
  }
  setInkPlan(plan: unknown): ShellSnapshot {
    this.commit({ inkPlan: normalizeInkPlan(plan) })
    return this.snapshot()
  }
  setHudSettings(patch: unknown): ShellSnapshot {
    const raw = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
    const mergedTools =
      raw.visibleTools && typeof raw.visibleTools === 'object'
        ? { ...this.preferences.hudSettings.visibleTools, ...(raw.visibleTools as Record<string, unknown>) }
        : this.preferences.hudSettings.visibleTools
    const hudSettings = normalizeHudSettings({
      ...this.preferences.hudSettings,
      ...raw,
      visibleTools: mergedTools,
    })
    this.commit({ hudSettings })
    this.windows.hudSettingsChanged?.(hudSettings)
    return this.snapshot()
  }
  setHudVisible(visible: unknown): ShellSnapshot {
    if (typeof visible !== 'boolean' || !this.windows.hudAvailable()) throw new Error('HUD unavailable')
    if (visible) this.windows.hud()
    else this.windows.hideHud()
    this.refresh()
    return this.snapshot()
  }
  selectForm(form: unknown): ShellSnapshot {
    if (form !== 'standard' && form !== 'hud') throw new Error('Unknown desktop form')
    if (form === 'hud' && !this.windows.hudAvailable())
      throw new Error('HUD is unavailable in this host')
    if (form === 'hud') {
      this.windows.hud()
    } else {
      this.restore()
      return this.snapshot()
    }
    this.refresh()
    return this.snapshot()
  }
  /** An additional window never changes the user's startup form. */
  open(surface: unknown, view?: unknown): ShellSnapshot {
    if (surface === 'screen') this.windows.screen()
    else if (surface === 'standard') {
      if (view !== undefined) this.navigate(view)
      this.windows.standard()
    } else if (surface === 'hud' && this.windows.hudAvailable()) this.windows.hud()
    else throw new Error('Unknown or unavailable surface')
    this.refresh()
    return this.snapshot()
  }
  restore(): void {
    // Opening the app must always reveal its control centre, even for legacy HUD-only profiles.
    // This is navigation, not a configuration write; a full disk must not hide the app.
    this.preferences = { ...this.preferences, view: 'control', focusMode: false }
    this.windows.focusMode?.(false)
    this.windows.standard()
    this.refresh()
  }
}
export function shellPreferenceStore(path: string) {
  return {
    read(): ShellPreferences {
      try {
        return normalizeShellPreferences(JSON.parse(readFileSync(path, 'utf8')))
      } catch {
        return normalizeShellPreferences(undefined)
      }
    },
    write(value: ShellPreferences): void {
      writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 })
      renameSync(path + '.tmp', path)
    },
  }
}

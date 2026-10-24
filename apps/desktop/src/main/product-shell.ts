import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import {
  isProductView,
  normalizeShellPreferences,
  type ShellPreferences,
  type ShellSnapshot,
} from '@codepulse/shared'

export interface ShellWindows {
  hudAvailable: () => boolean
  standard: () => void
  hud: () => void
  screen: () => void
  hideStandard: () => void
  hideHud: () => void
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
    return { ...this.preferences, hudAvailable: this.windows.hudAvailable() }
  }
  private commit(patch: Partial<ShellPreferences>) {
    const next = { ...this.preferences, ...patch }
    this.save(next)
    this.preferences = next
    this.changed(this.snapshot())
  }
  navigate(view: unknown): ShellSnapshot {
    if (!isProductView(view)) throw new Error('Unknown product view')
    this.commit({ view })
    return this.snapshot()
  }
  selectForm(form: unknown): ShellSnapshot {
    if (form !== 'standard' && form !== 'hud') throw new Error('Unknown desktop form')
    if (form === 'hud' && !this.windows.hudAvailable())
      throw new Error('HUD is unavailable in this host')
    this.commit({ form })
    if (form === 'hud') {
      this.windows.hud()
      this.windows.hideStandard()
    } else {
      this.windows.standard()
      this.windows.hideHud()
    }
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
    return this.snapshot()
  }
  restore(): void {
    if (this.preferences.form === 'hud' && this.windows.hudAvailable()) this.windows.hud()
    else this.windows.standard()
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

/** Concrete colors for the BrowserWindow and its native caption buttons. */
export interface WindowChromePalette {
  /** BrowserWindow background (`--canvas`), also the HUD and screen workbench window color. */
  backgroundColor: string
  /** Native minimize, maximize, and close button background (`--surface-muted`). */
  overlayColor: string
  /** Native minimize, maximize, and close symbol color (`--ink`). */
  symbolColor: string
}

/** Renderer-selected light or dark window palette. */
export type WindowTheme = 'light' | 'dark'

/**
 * Native chrome colors, each equal to a `.app-shell.native-workstation` token in
 * renderer/src/components/product-shell.css (light and dark); tests/window-chrome.test.ts enforces it.
 * - `backgroundColor` is `--canvas`, the window and sidebar color.
 * - `overlayColor` is `--surface-muted`: on Windows the caption buttons sit over the main area, which
 *   extends to the top of the window, so they must blend with it.
 * - `symbolColor` is `--ink`.
 */
const WINDOW_CHROME_PALETTES: Record<WindowTheme, WindowChromePalette> = {
  light: {
    backgroundColor: '#eceeef',
    overlayColor: '#f2f3f5',
    symbolColor: '#25282d',
  },
  dark: {
    backgroundColor: '#191b1e',
    overlayColor: '#202328',
    symbolColor: '#e8eaed',
  },
}

/**
 * Normalizes an IPC value to a supported window theme.
 *
 * @param value Untrusted renderer value.
 * @returns The requested dark theme or the safe light fallback.
 */
export function normalizeWindowTheme(value: unknown): WindowTheme {
  return value === 'dark' ? 'dark' : 'light'
}

/**
 * Returns native window colors matching the renderer canvas tokens.
 *
 * @param theme Concrete window theme.
 * @returns Immutable color values for BrowserWindow chrome.
 */
export function windowChromePalette(theme: WindowTheme): WindowChromePalette {
  return WINDOW_CHROME_PALETTES[theme]
}

/**
 * Chooses the initial palette before the renderer can restore saved preferences.
 *
 * The renderer remains authoritative and updates this value before the window is
 * shown. This fallback follows the dashboard's default 08:00–20:00 light schedule.
 *
 * @param now Local time used to select the initial palette.
 * @returns Light during daytime and dark outside the configured interval.
 */
export function scheduledWindowTheme(now: Date = new Date()): WindowTheme {
  const hour = now.getHours()
  return hour >= 8 && hour < 20 ? 'light' : 'dark'
}

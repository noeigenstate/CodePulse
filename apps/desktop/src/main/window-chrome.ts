/** Concrete palette shared by the native title bar and BrowserWindow background. */
export interface WindowChromePalette {
  /** BrowserWindow background and title-bar overlay color. */
  backgroundColor: string
  /** Native minimize, maximize, and close symbol color. */
  symbolColor: string
}

/** Renderer-selected light or dark window palette. */
export type WindowTheme = 'light' | 'dark'

/** Native chrome colors mirrored from the renderer's light and dark CSS tokens. */
const WINDOW_CHROME_PALETTES: Record<WindowTheme, WindowChromePalette> = {
  light: {
    backgroundColor: '#f6f9ff',
    symbolColor: '#334155',
  },
  dark: {
    backgroundColor: '#090b10',
    symbolColor: '#f3f5f8',
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

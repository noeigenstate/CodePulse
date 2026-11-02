/** Concrete palette shared by the native title bar and BrowserWindow background. */
export interface WindowChromePalette {
  /** BrowserWindow background and title-bar overlay color. */
  backgroundColor: string
  /** Native minimize, maximize, and close symbol color. */
  symbolColor: string
}

/** Renderer-selected light or dark window palette. */
export type WindowTheme = 'light' | 'dark'

/**
 * Native chrome colors. They must equal the `.app-shell.native-workstation` `--canvas` and `--ink`
 * tokens in renderer/src/components/product-shell.css (light and dark), because the Windows caption
 * buttons sit next to the renderer-drawn title bar; tests/window-chrome.test.ts enforces it.
 */
const WINDOW_CHROME_PALETTES: Record<WindowTheme, WindowChromePalette> = {
  light: {
    backgroundColor: '#eceeef',
    symbolColor: '#25282d',
  },
  dark: {
    backgroundColor: '#191b1e',
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

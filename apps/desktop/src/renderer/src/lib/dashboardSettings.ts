import type { AgentType } from '@codepulse/shared'

/**
 * Lists CLI panels supported by the dashboard preference schema.
 *
 * Order controls the settings UI. Hiding a tool only changes renderer visibility;
 * it never disables that tool's hook, session sync, or notifications.
 */
export const CLI_TOOL_TYPES = [
  'codex',
  'claude_code',
  'grok',
  'kimi',
] as const satisfies readonly AgentType[]

/** One supported CLI tool key stored in {@link DashboardSettings.visibleTools}. */
export type CliToolType = (typeof CLI_TOOL_TYPES)[number]

/** Palette exposed to the dashboard root element. */
export type ThemeMode = 'light' | 'dark'

/** Persisted theme selection, including the time-based automatic mode. */
export type ThemePreference = 'auto' | ThemeMode

/** Optional motion applied only to orange project surfaces that need attention. */
export type HudAttentionEffect = 'steady' | 'breathe' | 'pulse'

/** Project-first HUD arrangement. List is the focused default; grid remains optional. */
export type HudProjectLayout = 'grid' | 'list'

/** Persisted display-only preferences for the desktop dashboard. */
export interface DashboardSettings {
  theme: ThemePreference
  /** Background alpha only; text and controls always remain fully opaque. */
  hudOpacity: number
  attentionEffect: HudAttentionEffect
  projectLayout: HudProjectLayout
  showUsageStrip: boolean
  visibleTools: Record<CliToolType, boolean>
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface ThemeRoot {
  dataset: { theme?: string }
}

export const DASHBOARD_SETTINGS_STORAGE_KEY = 'codepulse:dashboard-settings'
/** Version 2 changes the original three-column default into a single project lane. */
const DASHBOARD_SETTINGS_SCHEMA_VERSION = 2
const LIGHT_THEME_START_HOUR = 8
const DARK_THEME_START_HOUR = 20
export const HUD_OPACITY_MIN = 20
export const HUD_OPACITY_MAX = 100

/** Default preferences; newly introduced CLI tools are also treated as visible on read. */
export const DEFAULT_DASHBOARD_SETTINGS: DashboardSettings = {
  // The companion HUD defaults to GroundControl's light, black-text language.
  theme: 'light',
  hudOpacity: 92,
  attentionEffect: 'steady',
  projectLayout: 'list',
  showUsageStrip: true,
  visibleTools: {
    codex: true,
    claude_code: true,
    grok: true,
    kimi: true,
  },
}

/**
 * Reads a defensive, forward-compatible local preference snapshot.
 *
 * Missing, malformed, or unreadable storage falls back to defaults. A stored
 * tool is hidden only when its value is explicitly `false`, so preferences made
 * before a newly supported tool was added automatically keep that tool visible.
 *
 * @param storage Browser storage, or `undefined` for non-browser callers.
 * @returns A complete display preference object safe for immediate rendering.
 */
export function readDashboardSettings(storage: StorageLike | undefined): DashboardSettings {
  let raw: string | null | undefined
  try {
    raw = storage?.getItem(DASHBOARD_SETTINGS_STORAGE_KEY)
  } catch {
    return cloneSettings(DEFAULT_DASHBOARD_SETTINGS)
  }
  if (!raw) return cloneSettings(DEFAULT_DASHBOARD_SETTINGS)

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed)) return cloneSettings(DEFAULT_DASHBOARD_SETTINGS)
    const visibleTools = isRecord(parsed.visibleTools) ? parsed.visibleTools : {}
    return {
      theme: isThemePreference(parsed.theme) ? parsed.theme : DEFAULT_DASHBOARD_SETTINGS.theme,
      hudOpacity: normalizeHudOpacity(parsed.hudOpacity),
      attentionEffect: isHudAttentionEffect(parsed.attentionEffect)
        ? parsed.attentionEffect
        : DEFAULT_DASHBOARD_SETTINGS.attentionEffect,
      projectLayout:
        parsed.schemaVersion === DASHBOARD_SETTINGS_SCHEMA_VERSION &&
        isHudProjectLayout(parsed.projectLayout)
          ? parsed.projectLayout
          : DEFAULT_DASHBOARD_SETTINGS.projectLayout,
      showUsageStrip:
        typeof parsed.showUsageStrip === 'boolean'
          ? parsed.showUsageStrip
          : DEFAULT_DASHBOARD_SETTINGS.showUsageStrip,
      visibleTools: {
        codex: visibleTools.codex !== false,
        claude_code: visibleTools.claude_code !== false,
        grok: visibleTools.grok !== false,
        kimi: visibleTools.kimi !== false,
      },
    }
  } catch {
    return cloneSettings(DEFAULT_DASHBOARD_SETTINGS)
  }
}

/**
 * Resolves a stored preference to the palette that should be active now.
 *
 * Automatic mode uses the local machine clock: light from 08:00 inclusive to
 * 20:00 exclusive, and dark for the remaining hours.
 *
 * @param preference User's persisted theme selection.
 * @param now Local time to evaluate, primarily injectable for deterministic tests.
 * @returns The concrete palette to expose to CSS.
 */
export function resolveTheme(preference: ThemePreference, now: Date = new Date()): ThemeMode {
  if (preference !== 'auto') return preference

  const hour = now.getHours()
  return hour >= LIGHT_THEME_START_HOUR && hour < DARK_THEME_START_HOUR ? 'light' : 'dark'
}

/**
 * Calculates the delay until the next automatic theme boundary in local time.
 *
 * @param now Local time from which to schedule the next palette change.
 * @returns Positive milliseconds until 08:00 or 20:00, whichever comes next.
 */
export function millisecondsUntilScheduledThemeChange(now: Date = new Date()): number {
  const nextBoundary = new Date(now)
  const hour = now.getHours()

  if (hour >= LIGHT_THEME_START_HOUR && hour < DARK_THEME_START_HOUR) {
    nextBoundary.setHours(DARK_THEME_START_HOUR, 0, 0, 0)
  } else {
    nextBoundary.setHours(LIGHT_THEME_START_HOUR, 0, 0, 0)
    if (hour >= DARK_THEME_START_HOUR) nextBoundary.setDate(nextBoundary.getDate() + 1)
  }

  return Math.max(1, nextBoundary.getTime() - now.getTime())
}

/**
 * Best-effort persists display preferences without interrupting the current UI state.
 *
 * @param storage Browser storage, or `undefined` for non-browser callers.
 * @param settings Complete preference snapshot to serialize.
 */
export function writeDashboardSettings(
  storage: StorageLike | undefined,
  settings: DashboardSettings,
): void {
  try {
    storage?.setItem(
      DASHBOARD_SETTINGS_STORAGE_KEY,
      JSON.stringify({ schemaVersion: DASHBOARD_SETTINGS_SCHEMA_VERSION, ...settings }),
    )
  } catch {
    // Keep the in-memory selection when browser storage is unavailable or full.
  }
}

/**
 * Applies the selected palette at the document root so every surface switches together.
 *
 * @param root Root element-like object that owns the `data-theme` attribute.
 * @param theme Palette to expose to CSS variables and Tailwind utilities.
 */
export function applyTheme(root: ThemeRoot, theme: ThemeMode): void {
  root.dataset.theme = theme
}

/** Creates a mutable copy so callers cannot alter the shared defaults object. */
function cloneSettings(settings: DashboardSettings): DashboardSettings {
  return {
    theme: settings.theme,
    hudOpacity: settings.hudOpacity,
    attentionEffect: settings.attentionEffect,
    projectLayout: settings.projectLayout,
    showUsageStrip: settings.showUsageStrip,
    visibleTools: { ...settings.visibleTools },
  }
}

/** Narrows parsed JSON to a non-null object before reading optional properties. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Narrows a parsed storage value to a supported persisted theme selection. */
function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'auto' || value === 'light' || value === 'dark'
}

function isHudAttentionEffect(value: unknown): value is HudAttentionEffect {
  return value === 'steady' || value === 'breathe' || value === 'pulse'
}

function isHudProjectLayout(value: unknown): value is HudProjectLayout {
  return value === 'grid' || value === 'list'
}

function normalizeHudOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DASHBOARD_SETTINGS.hudOpacity
  }
  return Math.min(HUD_OPACITY_MAX, Math.max(HUD_OPACITY_MIN, Math.round(value)))
}

/** Legacy routes remain accepted for saved preferences and older tray links. */
export const PRODUCT_VIEWS = [
  'control',
  'work',
  'usage',
  'ambient',
  'plugins',
  'assistant',
  'settings',
  'overview',
  'screen',
] as const
export type ProductView = (typeof PRODUCT_VIEWS)[number]
export type DesktopForm = 'standard' | 'hud'
export type PresentationTarget = 'desktop' | 'hud' | 'ink'
export type DesktopLayout = 'work' | 'usage' | 'board'
export type InkDisplayMode = 'single' | 'cycle'
export type InkFeatureId = 'work' | 'ambient' | 'todos'
export type InkCycleInterval = 5 | 10 | 15 | 30
export interface InkDisplayPlan {
  mode: InkDisplayMode
  fixed: InkFeatureId
  items: InkFeatureId[]
  intervalMinutes: InkCycleInterval
}
export type HudThemePreference = 'auto' | 'light' | 'dark'
export type HudAttentionStyle = 'steady' | 'breathe' | 'pulse'
export type HudLayoutMode = 'grid' | 'list'
export type HudToolKey = 'codex' | 'claude_code' | 'grok' | 'kimi' | 'antigravity'
/** How the floating HUD presents itself. `panel` is the original card deck. */
export const HUD_SURFACE_STYLES = ['panel', 'island', 'pills', 'edge', 'orb'] as const
export type HudSurfaceStyle = (typeof HUD_SURFACE_STYLES)[number]
/** Top-left corner of the orb in screen coordinates (DIP). */
export interface HudOrbPosition {
  x: number
  y: number
}
/**
 * Compact styles run in a fixed transparent stage window. The renderer draws its
 * surface inside the stage; the anchors say which stage corner the orb sits in.
 */
export interface HudStageInfo {
  style: HudSurfaceStyle
  anchorH: 'left' | 'right'
  anchorV: 'top' | 'bottom'
}
/** `start` and `move` read the cursor in the main process; `end` persists the position. */
export type HudDragPhase = 'start' | 'move' | 'end'
export interface HudAppearanceSettings {
  theme: HudThemePreference
  hudOpacity: number
  attentionEffect: HudAttentionStyle
  hudStyle: HudSurfaceStyle
  /** Show a hidden HUD, without taking focus, when a new alert arrives. */
  autoReveal: boolean
  orbPosition?: HudOrbPosition
  projectLayout: HudLayoutMode
  showUsageStrip: boolean
  resultRetentionMinutes: 10 | 30 | 60 | 120 | 240
  visibleTools: Record<HudToolKey, boolean>
}
export const DEFAULT_INK_PLAN: InkDisplayPlan = {
  mode: 'cycle',
  fixed: 'work',
  items: ['work', 'ambient'],
  intervalMinutes: 15,
}
export const DEFAULT_HUD_SETTINGS: HudAppearanceSettings = {
  theme: 'light',
  hudOpacity: 37,
  attentionEffect: 'steady',
  hudStyle: 'panel',
  autoReveal: false,
  projectLayout: 'list',
  showUsageStrip: true,
  resultRetentionMinutes: 30,
  visibleTools: {
    codex: true,
    claude_code: true,
    grok: true,
    kimi: true,
    antigravity: true,
  },
}
export interface ShellPreferences {
  version: 1
  form: DesktopForm
  view: ProductView
  target: PresentationTarget
  focusMode: boolean
  desktopLayout: DesktopLayout
  inkPlan: InkDisplayPlan
  hudSettings: HudAppearanceSettings
}
export interface ShellSnapshot extends ShellPreferences {
  hudAvailable: boolean
  hudVisible: boolean
}
export interface WorkbenchWindowState {
  pinned: boolean
  fullscreen: boolean
}
export function isProductView(value: unknown): value is ProductView {
  return PRODUCT_VIEWS.includes(value as ProductView)
}
export const PRESENTATION_TARGETS: readonly PresentationTarget[] = ['desktop', 'hud', 'ink']
export function canonicalProductView(view: ProductView): ProductView {
  return view === 'overview' || view === 'screen' || view === 'work' ? 'control' : view
}
export function productTargets(view: ProductView): readonly PresentationTarget[] {
  if (view === 'assistant') return ['desktop', 'ink']
  if (view === 'usage') return ['desktop']
  if (view === 'ambient') return ['ink']
  if (view === 'settings' || view === 'plugins') return []
  return PRESENTATION_TARGETS
}
export function targetForProductView(
  view: ProductView,
  target: PresentationTarget,
): PresentationTarget {
  const allowed = productTargets(view)
  return allowed.length && !allowed.includes(target) ? allowed[0]! : target
}
export function normalizeInkPlan(input: unknown): InkDisplayPlan {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const legacyFixed =
    value.mode === 'single' && (value.fixed === 'ambient' || value.fixed === 'todos')
  const mode: InkDisplayMode = value.mode === 'single' && !legacyFixed ? 'single' : 'cycle'
  const rawItems = Array.isArray(value.items)
    ? value.items.filter(
        (item): item is InkFeatureId => item === 'work' || item === 'ambient' || item === 'todos',
      )
    : (['work', 'ambient'] as InkFeatureId[])
  const items: InkFeatureId[] = legacyFixed
    ? ['work', value.fixed as InkFeatureId]
    : ['work', ...new Set(rawItems.filter((item) => item !== 'work'))]
  const intervalMinutes: InkCycleInterval =
    value.intervalMinutes === 5 || value.intervalMinutes === 10 || value.intervalMinutes === 30
      ? value.intervalMinutes
      : 15
  return { mode, fixed: 'work', items, intervalMinutes }
}
export function normalizeHudSettings(input: unknown): HudAppearanceSettings {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const tools =
    value.visibleTools && typeof value.visibleTools === 'object'
      ? (value.visibleTools as Record<string, unknown>)
      : {}
  const retention = value.resultRetentionMinutes
  const orb = value.orbPosition as Partial<HudOrbPosition> | null | undefined
  const orbPosition =
    orb && Number.isFinite(orb.x) && Number.isFinite(orb.y)
      ? { x: Math.round(orb.x!), y: Math.round(orb.y!) }
      : undefined
  return {
    theme: value.theme === 'auto' || value.theme === 'dark' ? value.theme : 'light',
    hudOpacity:
      typeof value.hudOpacity === 'number' && Number.isFinite(value.hudOpacity)
        ? Math.min(100, Math.max(20, Math.round(value.hudOpacity)))
        : DEFAULT_HUD_SETTINGS.hudOpacity,
    attentionEffect:
      value.attentionEffect === 'breathe' || value.attentionEffect === 'pulse'
        ? value.attentionEffect
        : 'steady',
    hudStyle: HUD_SURFACE_STYLES.includes(value.hudStyle as HudSurfaceStyle)
      ? (value.hudStyle as HudSurfaceStyle)
      : DEFAULT_HUD_SETTINGS.hudStyle,
    autoReveal: value.autoReveal === true,
    ...(orbPosition ? { orbPosition } : {}),
    projectLayout: value.projectLayout === 'grid' ? 'grid' : 'list',
    showUsageStrip: typeof value.showUsageStrip === 'boolean' ? value.showUsageStrip : true,
    resultRetentionMinutes:
      retention === 10 ||
      retention === 30 ||
      retention === 60 ||
      retention === 120 ||
      retention === 240
        ? retention
        : 30,
    visibleTools: {
      codex: tools.codex !== false,
      claude_code: tools.claude_code !== false,
      grok: tools.grok !== false,
      kimi: tools.kimi !== false,
      antigravity: tools.antigravity !== false,
    },
  }
}
export function normalizeShellPreferences(input: unknown): ShellPreferences {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const view = isProductView(value.view) ? canonicalProductView(value.view) : 'control'
  const target =
    value.view === 'screen'
      ? 'ink'
      : PRESENTATION_TARGETS.includes(value.target as PresentationTarget)
        ? (value.target as PresentationTarget)
        : 'desktop'
  return {
    version: 1,
    // Legacy startup-form input is accepted, but the client is always the entry point.
    form: 'standard',
    view,
    target: targetForProductView(view, target),
    focusMode: value.focusMode === true,
    desktopLayout:
      value.desktopLayout === 'board' || value.desktopLayout === 'usage'
        ? value.desktopLayout
        : 'work',
    inkPlan: normalizeInkPlan(value.inkPlan),
    hudSettings: normalizeHudSettings(value.hudSettings),
  }
}

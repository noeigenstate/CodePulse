/** Legacy routes remain accepted for saved preferences and older tray links. */
export const PRODUCT_VIEWS = ['control', 'work', 'usage', 'ambient', 'settings', 'overview', 'screen'] as const
export type ProductView = (typeof PRODUCT_VIEWS)[number]
export type DesktopForm = 'standard' | 'hud'
export type PresentationTarget = 'desktop' | 'hud' | 'ink'
export type DesktopLayout = 'work' | 'usage' | 'board'
export type InkDisplayMode = 'single' | 'cycle'
export type InkFeatureId = 'work' | 'ambient'
export type InkCycleInterval = 10 | 15 | 30
export interface InkDisplayPlan {
  mode: InkDisplayMode
  fixed: InkFeatureId
  items: InkFeatureId[]
  intervalMinutes: InkCycleInterval
}
export type HudThemePreference = 'auto' | 'light' | 'dark'
export type HudAttentionStyle = 'steady' | 'breathe' | 'pulse'
export type HudLayoutMode = 'grid' | 'list'
export type HudToolKey = 'codex' | 'claude_code' | 'grok' | 'kimi'
export interface HudAppearanceSettings {
  theme: HudThemePreference
  hudOpacity: number
  attentionEffect: HudAttentionStyle
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
  projectLayout: 'list',
  showUsageStrip: true,
  resultRetentionMinutes: 30,
  visibleTools: {
    codex: true,
    claude_code: true,
    grok: true,
    kimi: true,
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
  if (view === 'usage') return ['desktop']
  if (view === 'ambient') return ['ink']
  if (view === 'settings') return []
  return PRESENTATION_TARGETS
}
export function targetForProductView(view: ProductView, target: PresentationTarget): PresentationTarget {
  const allowed = productTargets(view)
  return allowed.length && !allowed.includes(target) ? allowed[0]! : target
}
export function normalizeInkPlan(input: unknown): InkDisplayPlan {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const mode: InkDisplayMode = value.mode === 'single' ? 'single' : 'cycle'
  const fixed: InkFeatureId = value.fixed === 'ambient' ? 'ambient' : 'work'
  const rawItems = Array.isArray(value.items)
    ? value.items.filter((item): item is InkFeatureId => item === 'work' || item === 'ambient')
    : []
  const items: InkFeatureId[] = rawItems.length > 0 ? [...new Set(rawItems)] : ['work', 'ambient']
  const intervalMinutes: InkCycleInterval =
    value.intervalMinutes === 10 || value.intervalMinutes === 30 ? value.intervalMinutes : 15
  return { mode, fixed, items, intervalMinutes }
}
export function normalizeHudSettings(input: unknown): HudAppearanceSettings {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const tools = value.visibleTools && typeof value.visibleTools === 'object'
    ? (value.visibleTools as Record<string, unknown>)
    : {}
  const retention = value.resultRetentionMinutes
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
    projectLayout: value.projectLayout === 'grid' ? 'grid' : 'list',
    showUsageStrip: typeof value.showUsageStrip === 'boolean' ? value.showUsageStrip : true,
    resultRetentionMinutes:
      retention === 10 || retention === 30 || retention === 60 || retention === 120 || retention === 240
        ? retention
        : 30,
    visibleTools: {
      codex: tools.codex !== false,
      claude_code: tools.claude_code !== false,
      grok: tools.grok !== false,
      kimi: tools.kimi !== false,
    },
  }
}
export function normalizeShellPreferences(input: unknown): ShellPreferences {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const view = isProductView(value.view) ? canonicalProductView(value.view) : 'control'
  const target = value.view === 'screen' ? 'ink' : PRESENTATION_TARGETS.includes(value.target as PresentationTarget)
    ? value.target as PresentationTarget : 'desktop'
  return {
    version: 1,
    // Legacy startup-form input is accepted, but the client is always the entry point.
    form: 'standard',
    view,
    target: targetForProductView(view, target),
    focusMode: value.focusMode === true,
    desktopLayout: value.desktopLayout === 'board' || value.desktopLayout === 'usage' ? value.desktopLayout : 'work',
    inkPlan: normalizeInkPlan(value.inkPlan),
    hudSettings: normalizeHudSettings(value.hudSettings),
  }
}

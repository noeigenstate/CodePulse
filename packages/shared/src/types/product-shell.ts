export const PRODUCT_VIEWS = ['overview', 'work', 'usage', 'ambient', 'screen'] as const
export type ProductView = (typeof PRODUCT_VIEWS)[number]
export type DesktopForm = 'standard' | 'hud'
export interface ShellPreferences {
  version: 1
  form: DesktopForm
  view: ProductView
}
export interface ShellSnapshot extends ShellPreferences {
  hudAvailable: boolean
}
export interface WorkbenchWindowState {
  pinned: boolean
  fullscreen: boolean
}
export function isProductView(value: unknown): value is ProductView {
  return PRODUCT_VIEWS.includes(value as ProductView)
}
export function normalizeShellPreferences(input: unknown): ShellPreferences {
  const value = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  return {
    version: 1,
    form: value.form === 'hud' ? 'hud' : 'standard',
    view: isProductView(value.view) ? value.view : 'overview',
  }
}

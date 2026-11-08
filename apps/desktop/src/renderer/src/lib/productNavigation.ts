import type { ProductView } from '@codepulse/shared'

export const TARGET_NAMES = {
  desktop: ['主窗口', 'Window'],
  hud: ['悬浮窗', 'Overlay'],
  ink: ['墨水屏设备', 'E-paper Device'],
} as const
export const PRODUCT_NAV: {
  id: ProductView
  label: string
  english: string
  icon: string
  parent?: 'ink'
}[] = [
  { id: 'window', label: '主窗口', english: 'Window', icon: 'desktop' },
  { id: 'overlay', label: '悬浮窗', english: 'Overlay', icon: 'hud' },
  { id: 'ink', label: '墨水屏设备', english: 'E-paper Device', icon: 'ink' },
  { id: 'plugins', label: '插件', english: 'Plugins', icon: 'plugins', parent: 'ink' },
  { id: 'usage', label: '开销', english: 'Spending', icon: 'usage' },
]

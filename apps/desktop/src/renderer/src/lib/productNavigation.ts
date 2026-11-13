import type { ProductView } from '@codepulse/shared'

export const TARGET_NAMES = {
  desktop: ['工作台', 'Workbench'],
  hud: ['悬浮窗', 'Overlay'],
  ink: ['墨水屏设备', 'E-paper Device'],
} as const
/** The sidebar's three groups, in order; each row of {@link PRODUCT_NAV} names the group it sits in. */
export const NAV_GROUPS = [
  { id: 'workspace', label: '工作空间', english: 'Workspace' },
  { id: 'devices', label: '设备与扩展', english: 'Devices & extensions' },
  { id: 'analytics', label: '数据分析', english: 'Analytics' },
] as const
export const PRODUCT_NAV: {
  id: ProductView
  label: string
  english: string
  icon: string
  group: (typeof NAV_GROUPS)[number]['id']
}[] = [
  { id: 'window', label: '工作台', english: 'Workbench', icon: 'desktop', group: 'workspace' },
  { id: 'overlay', label: '悬浮窗', english: 'Overlay', icon: 'hud', group: 'workspace' },
  { id: 'ink', label: '墨水屏设备', english: 'E-paper Device', icon: 'ink', group: 'devices' },
  { id: 'plugins', label: '插件', english: 'Plugins', icon: 'plugins', group: 'devices' },
  { id: 'usage', label: '用量与费用', english: 'Usage & cost', icon: 'usage', group: 'analytics' },
]

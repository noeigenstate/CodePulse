export const PERFORMANCE_LAYOUTS = ['detail', 'balanced', 'gpu'] as const
export type PerformanceLayout = (typeof PERFORMANCE_LAYOUTS)[number]
export interface InkPerformanceOptions {
  layout: PerformanceLayout
  gpu: string
  page: number
}
export function normalizePerformanceOptions(value?: unknown): InkPerformanceOptions {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  return {
    layout: v.layout === 'balanced' || v.layout === 'gpu' ? v.layout : 'detail',
    gpu:
      typeof v.gpu === 'string' &&
      /^(?:pci-[0-9a-f]{2,8}:[0-9a-f]{2}\.[0-7]|luid-[0-9a-f]{16})$/.test(v.gpu)
        ? v.gpu
        : 'auto',
    page:
      typeof v.page === 'number' && Number.isInteger(v.page)
        ? Math.min(999, Math.max(0, v.page))
        : 0,
  }
}
export interface PerformancePreview {
  status?: import('./device.js').DeviceStatusV1
  gpus: { id: string; name: string }[]
  pages: number
  warming: boolean
}

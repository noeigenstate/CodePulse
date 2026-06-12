import { nativeImage, type NativeImage } from 'electron'
import type { OverallState } from '@codepulse/shared'
import { trayIconPngFor } from './tray-icon-png.js'

const iconCache = new Map<OverallState, NativeImage>()

export function trayIconFor(state: OverallState): NativeImage {
  const cached = iconCache.get(state)
  if (cached) return cached
  const image = nativeImage
    .createFromBuffer(trayIconPngFor(state, 32))
    .resize({ width: 16, height: 16 })
  iconCache.set(state, image)
  return image
}

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { isDeviceThreadSource, normalizeDeviceThreadOrder, reconcileDeviceThreadOrder, toDeviceStatusV1 } from '@codepulse/core'
import type { DeviceDisplayConfig, StatusSnapshot } from '@codepulse/shared'

/** One projector for preview and LAN API; its order never mutates StatusHub or HUD storage. */
export function createDeviceDisplayProjector(path: string, onError: (error: unknown) => void = () => {}) {
  let order = normalizeDeviceThreadOrder(undefined)
  try { order = normalizeDeviceThreadOrder(JSON.parse(readFileSync(path, 'utf8'))) } catch { /* first run / malformed file */ }
  return (snapshot: StatusSnapshot, config?: DeviceDisplayConfig) => {
    // Unified host supplies the common HUD order; legacy order is only a fallback.
    if (snapshot.workOrder) return toDeviceStatusV1(snapshot, config)
    // Observe all supported live tasks, even those temporarily unchecked in a preview draft.
    const next = reconcileDeviceThreadOrder(snapshot.agents.filter(isDeviceThreadSource), order)
    if (JSON.stringify(next) !== JSON.stringify(order)) {
      order = next // Retain stable in-memory positions if the save fails.
      try {
        writeFileSync(`${path}.tmp`, JSON.stringify(order) + '\n', { encoding: 'utf8', mode: 0o600 })
        renameSync(`${path}.tmp`, path)
      } catch (error) { onError(error) }
    }
    return toDeviceStatusV1(snapshot, config, order)
  }
}

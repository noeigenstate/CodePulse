import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { normalizeDeviceDisplay, type DeviceDisplayConfig } from '@codepulse/shared'

export function readDeviceDisplayConfig(path: string): DeviceDisplayConfig {
  try { return normalizeDeviceDisplay(JSON.parse(readFileSync(path, 'utf8'))) }
  catch { return normalizeDeviceDisplay(undefined) }
}
/** Publish only after a successful atomic save; failure must reach the renderer. */
export function writeDeviceDisplayConfig(path: string, value: unknown): DeviceDisplayConfig {
  const config = normalizeDeviceDisplay(value)
  writeFileSync(`${path}.tmp`, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  renameSync(`${path}.tmp`, path)
  return config
}

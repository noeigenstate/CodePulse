import { normalizeDeviceLife, type DeviceLife } from '@codepulse/shared'
import { deviceText, deviceSupports } from './device-text.js'

/** Every string, including nested labels and enum ids, passes the real device glyph filter. */
export function deviceLife(value: unknown): DeviceLife | undefined {
  const normalize = (input: unknown): unknown =>
    typeof input === 'string'
      ? deviceText(input)
      : Array.isArray(input)
        ? input.map(normalize)
        : input && typeof input === 'object'
          ? Object.fromEntries(Object.entries(input).map(([key, item]) => [key, normalize(item)]))
          : input
  const supported = (input: unknown): boolean =>
    typeof input === 'string'
      ? deviceSupports(input)
      : Array.isArray(input)
        ? input.every(supported)
        : input && typeof input === 'object'
          ? Object.values(input).every(supported)
          : true
  // Shape/capacity is checked before recursion: attacker-controlled deep objects never reach it.
  const parsed = normalizeDeviceLife(value)
  if (!parsed) return undefined
  const normalized = normalize(parsed)
  return supported(normalized) ? normalizeDeviceLife(normalized) : undefined
}

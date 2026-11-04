import { normalizeDeviceLife, type DeviceLife } from '@codepulse/shared'
import { deviceText, deviceSupports } from './device-text.js'

/** Full-width punctuation the device draws natively; Chinese prose keeps it instead of ASCII. */
const WIDE = '，：；？！（）'
const keepWide = (input: string): string =>
  deviceText(
    input.replace(/[，：；？！（）]/g, (c) => String.fromCharCode(0xe000 + WIDE.indexOf(c))),
  ).replace(/[\uE000-\uE006]/g, (c) => WIDE[c.charCodeAt(0) - 0xe000]!)

/** Every string, including nested labels and enum ids, passes the real device glyph filter. */
export function deviceLife(value: unknown): DeviceLife | undefined {
  // Shape/capacity is checked before recursion: attacker-controlled deep objects never reach it.
  const parsed = normalizeDeviceLife(value)
  if (!parsed) return undefined
  // The reading cards are Chinese prose; other kinds fold full-width forms as before.
  const text = parsed.kind === 'concept' || parsed.kind === 'prompt' ? keepWide : deviceText
  const normalize = (input: unknown): unknown =>
    typeof input === 'string'
      ? text(input)
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
  const normalized = normalize(parsed)
  return supported(normalized) ? normalizeDeviceLife(normalized) : undefined
}

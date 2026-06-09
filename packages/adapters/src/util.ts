/**
 * Small defensive helpers for reading loosely-typed hook payloads. Agent hook
 * JSON varies between versions and channels, so adapters read fields by trying
 * several candidate keys rather than assuming a fixed shape.
 *
 * @module adapters/util
 */

/**
 * Returns the first non-empty string found among the candidate keys.
 *
 * @param raw The record to read from.
 * @param keys Candidate keys, tried in order.
 * @returns The first matching string, or `undefined` if none match.
 */
export function pickString(raw: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Returns the first finite number found among the candidate keys.
 *
 * @param raw The record to read from.
 * @param keys Candidate keys, tried in order.
 * @returns The first matching number, or `undefined` if none match.
 */
export function pickNumber(raw: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value Any value (often a nested payload field).
 * @returns The value as a record, or `null` if it is not an object.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  return value as Record<string, unknown>
}

/**
 * Trims and truncates text to a privacy-friendly preview length
 * (requirements §5.8 — CodePulse never stores full prompts by default).
 *
 * @param text The text to preview, possibly `undefined`.
 * @param max Maximum length before truncation (default 120).
 * @returns The trimmed preview (with an ellipsis when truncated), or `undefined`.
 */
export function preview(text: string | undefined, max = 120): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

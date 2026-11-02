/**
 * The 「X 与 meme」 row switch drives two real rules (xEnabled, memeEnabled). Turning the row off
 * remembers the pair (also across restarts); turning it on restores exactly that pair. With nothing
 * remembered only meme turns on: the switch never enables X by itself, since X is a paid source.
 */
export interface SocialPair {
  xEnabled: boolean
  memeEnabled: boolean
}

/** No secrets here, only two booleans. */
export const SOCIAL_PAIR_KEY = 'codepulse:ambient-social-pair'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export const socialRowOn = (pair: SocialPair): boolean => pair.xEnabled || pair.memeEnabled

/** The remembered pair, or undefined when absent, unreadable or malformed. */
export function readRememberedSocial(storage: StorageLike | undefined): SocialPair | undefined {
  try {
    const raw = storage?.getItem(SOCIAL_PAIR_KEY)
    if (!raw) return undefined
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return undefined
    const { xEnabled, memeEnabled } = value as Record<string, unknown>
    if (typeof xEnabled !== 'boolean' || typeof memeEnabled !== 'boolean') return undefined
    return { xEnabled, memeEnabled }
  } catch {
    return undefined
  }
}

export function writeRememberedSocial(storage: StorageLike | undefined, pair: SocialPair | undefined): void {
  try {
    if (pair) storage?.setItem(SOCIAL_PAIR_KEY, JSON.stringify(pair))
    else storage?.removeItem?.(SOCIAL_PAIR_KEY)
  } catch {
    // Storage may be unavailable; the in-memory copy still works for this session.
  }
}

export function toggleSocialRow(
  current: SocialPair,
  remembered: SocialPair | undefined,
): { patch: SocialPair; remembered: SocialPair | undefined } {
  if (socialRowOn(current)) {
    return { patch: { xEnabled: false, memeEnabled: false }, remembered: { ...current } }
  }
  if (remembered && socialRowOn(remembered)) return { patch: { ...remembered }, remembered }
  return { patch: { xEnabled: false, memeEnabled: true }, remembered }
}

/**
 * An individual X or meme toggle (in the category's 设置) is the user's latest explicit choice, so it
 * replaces the remembered pair: the row switch must never bring back a source the user turned off
 * there. When the change leaves both off, nothing is remembered and the row falls back to meme only.
 */
export function rememberAfterFlag(
  current: SocialPair,
  flag: keyof SocialPair,
  value: boolean,
): SocialPair | undefined {
  const next = { ...current, [flag]: value }
  return socialRowOn(next) ? next : undefined
}

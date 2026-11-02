/**
 * The 「X 与 meme」 row switch drives two real rules (xEnabled, memeEnabled). Turning the row off
 * remembers the pair; turning it on restores that pair, so meme-only never silently becomes X + meme.
 */
export interface SocialPair {
  xEnabled: boolean
  memeEnabled: boolean
}

export const socialRowOn = (pair: SocialPair): boolean => pair.xEnabled || pair.memeEnabled

export function toggleSocialRow(
  current: SocialPair,
  remembered: SocialPair | undefined,
  hasXKey: boolean,
): { patch: SocialPair; remembered: SocialPair | undefined } {
  if (socialRowOn(current)) {
    return { patch: { xEnabled: false, memeEnabled: false }, remembered: { ...current } }
  }
  if (remembered && socialRowOn(remembered)) return { patch: { ...remembered }, remembered }
  // Nothing remembered: meme needs no key; X only when a key is already saved.
  return { patch: { xEnabled: hasXKey, memeEnabled: true }, remembered }
}

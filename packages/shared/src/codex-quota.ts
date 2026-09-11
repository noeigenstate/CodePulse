/** Independent Codex allowances used consistently by storage and display layers. */
export type CodexQuotaFamily = 'main' | 'spark' | 'reserve' | `named:${string}`

/**
 * Resolves a Codex quota family with native IDs taking precedence over names.
 *
 * Anonymous legacy snapshots share ordinary Codex usage. Known aliases share
 * their respective allowance, while every other ID retains an isolated key.
 * A conflicting display name must never move values into another quota family.
 *
 * @param rateLimitId Native quota identifier, when supplied.
 * @param rateLimitName Display name used only when the identifier is absent.
 * @returns Stable allowance identity for synchronization and presentation.
 */
export function codexQuotaFamily(
  rateLimitId: string | undefined,
  rateLimitName?: string,
): CodexQuotaFamily {
  const identity = (rateLimitId?.trim() || rateLimitName?.trim() || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
  if (!identity || identity === 'codex' || identity === 'default' || identity === 'weekly') {
    return 'main'
  }
  if (identity.includes('spark') || identity.includes('bengalfox')) return 'spark'
  if (
    identity === 'base_model_inference' ||
    identity === 'gpt-reserve' ||
    identity === 'gpt reserve'
  ) {
    return 'reserve'
  }
  return `named:${identity}`
}

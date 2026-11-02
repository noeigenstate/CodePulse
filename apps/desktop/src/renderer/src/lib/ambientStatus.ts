import type { AmbientCard, AmbientSnapshot } from '@codepulse/shared'

/**
 * Source status strings that are not problems. Anything else the service reports (no key, rate
 * limit, access denied, bad data, ...) is treated as an error, so a new error wording is never hidden.
 */
const NEUTRAL = /^(已关闭|找到|本轮没有|已准备|尚未检查|离线可用)/

/** True when a source status text describes a problem worth showing in its category. */
export function isSourceProblem(text: string | undefined): boolean {
  const value = (text ?? '').trim()
  return Boolean(value) && !NEUTRAL.test(value)
}

export type AmbientCategory = 'concept' | 'prompt' | 'pet' | 'calendar' | 'news' | 'social' | 'local'

/** The error to show inside a category, or ''. Only enabled online sources can have one. */
export function categoryProblem(
  category: AmbientCategory,
  status: AmbientSnapshot['sourceStatus'] | undefined,
  enabled: { x: boolean; meme: boolean; news: boolean },
): string {
  if (!status) return ''
  const bad = (text?: string) => (isSourceProblem(text) ? (text as string) : '')
  if (category === 'social') return (enabled.x ? bad(status.x) : '') || (enabled.meme ? bad(status.meme) : '')
  if (category === 'news') return enabled.news ? bad(status.news) : ''
  return ''
}

const KINDS: Partial<Record<AmbientCategory, AmbientCard['kind'][]>> = {
  news: ['news'],
  social: ['x', 'meme'],
}

/**
 * Result line after a manual 检查新内容: how many cards of this category are new, plus the
 * category's error when there is one.
 */
export function refreshSummary(
  category: AmbientCategory,
  before: ReadonlySet<string>,
  after: AmbientCard[],
  problem: string,
): string {
  const kinds = KINDS[category] ?? []
  const added = after.filter((card) => kinds.includes(card.kind) && !before.has(card.id)).length
  const found = added > 0 ? `找到 ${added} 条新内容` : '没有新内容'
  return problem ? `${found}；${problem}` : found
}

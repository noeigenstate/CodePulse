import type { Locale } from './i18n.js'

const two = (n: number): string => String(n).padStart(2, '0')

/** Day-relative reminder time: 「今天 18:00」, 「明天 09:00」, otherwise 「2026/11/03 09:00」. */
export function formatDue(at: number, now: number, locale: Locale): string {
  const date = new Date(at)
  const clock = `${two(date.getHours())}:${two(date.getMinutes())}`
  const dayStart = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((dayStart(at) - dayStart(now)) / 86_400_000)
  const zh = locale === 'zh'
  if (days === 0) return `${zh ? '今天' : 'Today'} ${clock}`
  if (days === 1) return `${zh ? '明天' : 'Tomorrow'} ${clock}`
  if (days === -1) return `${zh ? '昨天' : 'Yesterday'} ${clock}`
  return `${date.getFullYear()}/${two(date.getMonth() + 1)}/${two(date.getDate())} ${clock}`
}

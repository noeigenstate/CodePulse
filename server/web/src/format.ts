import type { PluginKind } from '@codepulse/shared'

export const kindName: Record<PluginKind, string> = {
  builtin: '内置',
  pack: '内容包',
  webhook: 'Webhook',
}

/** Two capitals ("Hacker News" → HN, "GitHub" → GH), else the last CJK character (每日古诗 → 诗). */
export function iconText(name: string) {
  const capitals = name.match(/[A-Z]/g)
  if (capitals && capitals.length > 1) return capitals.slice(0, 2).join('')
  const cjk = name.match(/\p{Script=Han}/gu)
  return cjk ? cjk[cjk.length - 1] : Array.from(name)[0]
}

export function countText(n: number) {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
}

export function relativeTime(at: number | null, now = Date.now()) {
  if (at === null) return '—'
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return `${Math.floor(minutes / 1440)} 天前`
}

export function dateTime(at: number) {
  const d = new Date(at)
  const clock = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString()
    ? `今天 ${clock}`
    : `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`
}

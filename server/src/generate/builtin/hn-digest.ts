import { createHash } from 'node:crypto'
import {
  isPlainText,
  type PluginCard,
  type PluginSettingValues,
  type LifeHnStory,
} from '@codepulse/shared'
import { validateCards } from '../../validation.js'

function clean(value: unknown, max: number): string {
  return Array.from(typeof value === 'string' ? value : '')
    .filter((char) => isPlainText(char, 1))
    .slice(0, max)
    .join('')
}

export async function hnDigest(
  settings: PluginSettingValues,
  now: number,
  fetcher: typeof fetch,
  signal: AbortSignal,
  timeZone: string,
): Promise<PluginCard[]> {
  const response = await fetcher(
    'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30',
    { signal },
  )
  if (!response.ok) throw new Error('新闻来源暂时不可用')
  const data = (await response.json()) as { hits?: unknown[] }
  if (!Array.isArray(data.hits)) throw new Error('新闻数据无效')
  const stories: LifeHnStory[] = []
  for (const raw of data.hits) {
    if (!raw || typeof raw !== 'object') continue
    const hit = raw as Record<string, unknown>
    if (typeof hit.points !== 'number' || hit.points < Number(settings.minPoints)) continue
    const title = clean(hit.title, 120)
    if (!title.trim()) continue
    let site = ''
    try {
      site = new URL(String(hit.url)).hostname.replace(/^www\./, '')
    } catch {
      /* Ask HN has no URL. */
    }
    const ageHours = Math.max(0, Math.floor((now / 1000 - Number(hit.created_at_i)) / 3600))
    stories.push({
      title,
      points: Math.max(0, Math.min(999999, Math.floor(hit.points))),
      comments:
        typeof hit.num_comments === 'number' && Number.isFinite(hit.num_comments)
          ? Math.max(0, Math.min(999999, Math.floor(hit.num_comments)))
          : 0,
      site: clean(site, 32),
      age: Number.isFinite(ageHours) ? clean(`${ageHours}小时`, 8) : '',
    })
    if (stories.length >= Number(settings.count)) break
  }
  if (!stories.length) throw new Error('暂无符合条件的新闻')
  const updated = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now)
  const id = createHash('sha256')
    .update(JSON.stringify(stories.map(({ title, site }) => ({ title, site }))))
    .digest('hex')
    .slice(0, 20)
  return validateCards(
    [
      {
        id: `hn-${id}`,
        source: 'Hacker News 摘要',
        text: Array.from(stories.map((s) => s.title).join('｜'))
          .slice(0, 400)
          .join(''),
        life: { v: 1, kind: 'hn', updated, stories },
      },
    ],
    now,
    now + 2 * 15 * 60000,
    1,
  )
}

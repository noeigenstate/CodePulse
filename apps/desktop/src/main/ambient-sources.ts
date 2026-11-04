import { createHash } from 'node:crypto'
import type { AmbientCard, AmbientConfig } from '@codepulse/shared'
import { cleanText, xMinimumLikes } from './ambient-rules.js'

export type JsonRequest = (url: string, headers?: Record<string, string>) => Promise<unknown>
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const score = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0)
export function xQuery(config: AmbientConfig, now: number): string {
  const from = '(' + config.accounts.map((a) => 'from:' + a).join(' OR ') + ')'
  return config.provider === 'twitterapi'
    ? `${from} -filter:replies -filter:retweets min_faves:${Math.min(...config.accounts.map((a) => xMinimumLikes(config, a)), config.minLikes)} since_time:${Math.floor((now - 12 * 3600000) / 1000)}`
    : `${from} -is:reply -is:retweet`
}
export async function collectX(
  config: AmbientConfig,
  key: string,
  now: number,
  request: JsonRequest,
): Promise<AmbientCard[]> {
  if (!key || !config.accounts.length) return []
  const params = new URLSearchParams({ query: xQuery(config, now) })
  let body: Record<string, unknown>
  if (config.provider === 'twitterapi') {
    params.set('queryType', 'Top')
    body = object(
      await request('https://api.twitterapi.io/twitter/tweet/advanced_search?' + params, {
        'X-API-Key': key,
      }),
    )
    if (!Array.isArray(body.tweets)) throw new Error('数据源返回格式异常')
  } else {
    params.set('max_results', '10')
    params.set('sort_order', 'relevancy')
    params.set('start_time', new Date(now - 12 * 3600000).toISOString())
    params.set('tweet.fields', 'created_at,public_metrics,possibly_sensitive,referenced_tweets')
    params.set('expansions', 'author_id')
    params.set('user.fields', 'username')
    body = object(
      await request('https://api.x.com/2/tweets/search/recent?' + params, {
        Authorization: 'Bearer ' + key,
      }),
    )
    if (list(body.errors).length || (!Array.isArray(body.data) && !body.meta))
      throw new Error('X 返回错误，请检查权限或余额')
  }
  const users = list(object(body.includes).users).map(object)
  return list(config.provider === 'twitterapi' ? body.tweets : body.data).flatMap((raw) => {
    const t = object(raw),
      id = cleanText(t.id, 30)
    const author =
      config.provider === 'twitterapi'
        ? cleanText(object(t.author).userName, 15)
        : cleanText(users.find((u) => u.id === t.author_id)?.username, 15)
    const created = Date.parse(String(t.createdAt ?? t.created_at))
    if (
      !/^\d+$/.test(id) ||
      !/^[A-Za-z0-9_]+$/.test(author) ||
      !Number.isFinite(created) ||
      t.isReply ||
      t.retweeted_tweet ||
      t.possibly_sensitive ||
      t.possiblySensitive ||
      [...list(t.referenced_tweets), ...list(t.referenced_posts)].some((r) =>
        ['replied_to', 'retweeted'].includes(String(object(r).type)),
      )
    )
      return []
    return [
      {
        id: 'x:' + id,
        kind: 'x' as const,
        source: '@' + author,
        text: cleanText(t.text),
        url: `https://x.com/${author}/status/${id}`,
        publishedAt: created,
        expiresAt: created + 12 * 3600000,
        score: score(t.likeCount ?? object(t.public_metrics).like_count),
      },
    ]
  })
}
export function allowedMemeImage(url: string): boolean {
  try {
    const u = new URL(url)
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      ['i.redd.it', 'preview.redd.it'].includes(u.hostname)
    )
  } catch {
    return false
  }
}
export async function collectMemes(
  config: AmbientConfig,
  now: number,
  request: JsonRequest,
): Promise<AmbientCard[]> {
  const body = object(await request(`https://meme-api.com/gimme/${config.memeCommunity}/20`))
  if (!Array.isArray(body.memes)) throw new Error('meme 来源暂时不可用')
  return list(body.memes).flatMap((raw) => {
    const m = object(raw),
      link = cleanText(m.postLink, 300),
      image = cleanText(m.url, 500)
    if (
      m.nsfw !== false ||
      m.spoiler !== false ||
      !allowedMemeImage(image) ||
      !/^https:\/\/(?:redd\.it\/[a-z0-9]+|(?:www\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/comments\/[a-z0-9]+(?:\/[^?#]*)?)$/i.test(
        link,
      ) ||
      /\.(gif|mp4)(?:\?|$)/i.test(image)
    )
      return []
    return [
      {
        id: 'meme:' + link,
        kind: 'meme' as const,
        source: 'r/' + cleanText(m.subreddit, 40),
        text: cleanText(m.title, 300),
        url: link,
        imageUrl: image,
        publishedAt: now,
        expiresAt: now + 24 * 3600000,
        score: score(m.ups),
      },
    ]
  })
}
/** Fixed hosts, no redirects, bounded body/time; never forwards credentials to another host. */
export async function fetchBytes(
  url: string,
  headers: Record<string, string> = {},
  max = 512000,
  transport: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Uint8Array> {
  const response = await transport(url, {
    headers: { 'User-Agent': 'CodePulse-Desk/1.0', ...headers },
    redirect: 'error',
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? '访问被拒绝，请检查凭据与权限'
        : response.status === 429
          ? '来源限流，稍后自动重试'
          : `来源暂不可用 (${response.status})`,
    )
  const reader = response.body?.getReader()
  if (!reader) throw new Error('来源未返回内容')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.length
      if (total > max) throw new Error('来源内容过大')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}
export const fetchJson: JsonRequest = async (url, headers) =>
  JSON.parse(Buffer.from(await fetchBytes(url, headers)).toString('utf8'))

/**
 * One public page, only current front-page stories with substantial discussion, as a single
 * digest card of the four most-voted stories (the device draws it as a ranked list).
 */
export async function collectNews(now: number, request: JsonRequest): Promise<AmbientCard[]> {
  const params = new URLSearchParams({
    tags: 'front_page',
    hitsPerPage: '12',
    numericFilters: `points>=100,created_at_i>${Math.floor(now / 1000) - 86400}`,
  })
  const body = object(await request('https://hn.algolia.com/api/v1/search?' + params))
  if (!Array.isArray(body.hits)) throw new Error('数据源返回格式异常')
  const stories = list(body.hits).flatMap((raw) => {
    const h = object(raw),
      id = String(h.objectID),
      publishedAt = Number(h.created_at_i) * 1000,
      points = score(h.points)
    if (!/^\d+$/.test(id) || !Number.isFinite(publishedAt) || publishedAt > now || points < 100)
      return []
    const title = cleanText(h.title, 120)
    if (!title) return []
    let site = ''
    try {
      if (typeof h.url === 'string') site = new URL(h.url).hostname.replace(/^www\./, '')
    } catch {
      site = ''
    }
    return [{ id, title, points, comments: score(h.num_comments), site, publishedAt }]
  })
  const top = stories.sort((a, b) => b.points - a.points).slice(0, 4)
  if (!top.length) return []
  const age = (at: number) => {
    const minutes = Math.max(1, Math.floor((now - at) / 60000))
    return minutes < 60 ? `${minutes} 分钟前` : `${Math.floor(minutes / 60)} 小时前`
  }
  const clock = new Date(now)
  const pad = (n: number) => String(n).padStart(2, '0')
  return [
    {
      // The same four stories keep one id while their points move; a new story makes a new card.
      id:
        'hn:' +
        createHash('sha256')
          .update(
            top
              .map((s) => s.id)
              .sort()
              .join(','),
          )
          .digest('hex')
          .slice(0, 24),
      kind: 'news' as const,
      source: 'Hacker News · 热议',
      text: top
        .slice(0, 3)
        .map((s) => s.title)
        .join(' · '),
      url: 'https://news.ycombinator.com/',
      publishedAt: Math.max(...top.map((s) => s.publishedAt)),
      expiresAt: now + 12 * 3600000,
      score: top[0]!.points,
      layout: 'life' as const,
      life: {
        v: 1 as const,
        kind: 'hn' as const,
        updated: `${pad(clock.getHours())}:${pad(clock.getMinutes())}`,
        stories: top.map((s) => ({
          title: s.title,
          points: Math.min(999999, Math.round(s.points)),
          comments: Math.min(999999, Math.round(s.comments)),
          site: s.site.slice(0, 32),
          age: age(s.publishedAt),
        })),
      },
    },
  ]
}

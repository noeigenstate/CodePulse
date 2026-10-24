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
    params.set('post.fields', 'created_at,public_metrics,possibly_sensitive')
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
  const body = object(await request(`https://meme-api.com/gimme/${config.memeCommunity}/5`))
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
): Promise<Uint8Array> {
  const response = await fetch(url, {
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

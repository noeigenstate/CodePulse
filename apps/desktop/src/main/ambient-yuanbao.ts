import { createHash, createHmac } from 'node:crypto'
import type { AmbientCard, YuanbaoConfig, YuanbaoKeyInput, YuanbaoTopic } from '@codepulse/shared'
import type { HolidayTable } from './calendar/index.js'

export const YUANBAO_TIMEOUT_MS = 8000
export const YUANBAO_MAX_BYTES = 512000
export const YUANBAO_TTL_MS: Readonly<Record<YuanbaoTopic, number>> = {
  weather: 3 * 3600000,
  gold: 3600000,
  stock: 3600000,
  tools: 24 * 3600000,
  holiday: 7 * 24 * 3600000,
  news: 3 * 3600000,
}
export type YuanbaoCredentials = { secretId: string; secretKey: string } | { apiKey: string }
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest()
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown) => (typeof value === 'string' ? value : '')
const take = (value: string, count: number) => Array.from(value).slice(0, count).join('')
export function webText(value: unknown): string {
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&#160;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
  }
  return take(text(value), 12000)
    .replace(
      /&(?:nbsp|amp|lt|gt|quot);|&#(?:160|39);/gi,
      (entity) => entities[entity.toLowerCase()]!,
    )
    .replace(/<[^<>]{0,2000}>/g, ' ')
    .replace(/\[([^\[\]]{1,240})\]\([^()\n]{0,1000}\)/g, '$1')
    .replace(/[*_`#]/g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
export function yuanbaoCredentials(input: unknown): YuanbaoCredentials | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('密钥格式无效')
  const raw = record(input)
  if (Object.keys(raw).some((field) => !['secretId', 'secretKey', 'apiKey'].includes(field)))
    throw Error('密钥格式无效')
  const values = ['secretId', 'secretKey', 'apiKey'].map((field) => {
    const value = raw[field]
    if (value === undefined) return ''
    if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value))
      throw Error('密钥格式无效')
    return value.trim()
  })
  const [secretId, secretKey, apiKey] = values as [string, string, string]
  if (!secretId && !secretKey && !apiKey) return null
  if (apiKey && (secretId || secretKey)) throw Error('请选择一种鉴权方式')
  if (apiKey) return { apiKey }
  if (!secretId || !secretKey) throw Error('请填写完整密钥')
  return { secretId, secretKey }
}
export function signedYuanbaoHeaders(
  payload: string,
  credentials: { secretId: string; secretKey: string },
  timestamp: number,
  host = 'wsa.tencentcloudapi.com',
): Record<string, string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
  const scope = `${date}/wsa/tc3_request`
  const contentType = 'application/json; charset=utf-8'
  const canonical = [
    'POST',
    '/',
    '',
    `content-type:${contentType}\nhost:${host}\nx-tc-action:searchpro\n`,
    'content-type;host;x-tc-action',
    hash(payload),
  ].join('\n')
  const toSign = ['TC3-HMAC-SHA256', timestamp, scope, hash(canonical)].join('\n')
  const signingKey = hmac(hmac(hmac('TC3' + credentials.secretKey, date), 'wsa'), 'tc3_request')
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex')
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${credentials.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`,
    'Content-Type': contentType,
    'X-TC-Action': 'SearchPro',
    'X-TC-Timestamp': String(timestamp),
    'X-TC-Version': '2025-05-08',
  }
}
export function yuanbaoError(code: unknown, status?: number): string {
  const value = text(code)
  if (value.startsWith('AuthFailure')) return '密钥错误'
  if (/^(ResourceNotFound|ResourceUnavailable|UnauthorizedOperation)/.test(value))
    return '未开通或额度用完'
  if (value.startsWith('RequestLimitExceeded') || status === 429) return '限流，稍后再试'
  if (value.startsWith('InvalidParameter')) return '参数不被当前版本支持'
  if (status === 401 || status === 403) return '密钥错误'
  // Show the service's own code (never request data) so failures are diagnosable.
  if (/^[A-Za-z][\w.]{2,60}$/.test(value)) return `服务暂不可用（${value}）`
  return '连接失败'
}
/** Only response data reaches persistence. Exact credential values are also scrubbed if a server echoes them. */
export function sanitizeYuanbaoResponse(raw: unknown, credentials: YuanbaoKeyInput): unknown {
  const secrets = Object.values(credentials).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  const patterns = [
    ...new Set(secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)])),
  ].sort((a, b) => b.length - a.length)
  const scrub = (value: string) =>
    patterns.reduce((result, secret) => result.split(secret).join('[已隐藏]'), value)
  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') return scrub(value)
    if (Array.isArray(value)) return value.map(visit)
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
          scrub(key),
          /^(authorization|secretid|secretkey|apikey)$/i.test(key) ? '[已隐藏]' : visit(child),
        ]),
      )
    return value
  }
  return visit(raw)
}
export function yuanbaoResponseJson(raw: unknown): string {
  const json = JSON.stringify(raw)
  if (Buffer.byteLength(json) <= YUANBAO_MAX_BYTES) return json + '\n'
  const id = take(text(record(record(raw).Response).RequestId), 128)
  return JSON.stringify({ truncated: true, Response: { RequestId: id } }) + '\n'
}
export interface YuanbaoPage {
  title: string
  site: string
  date: string
  url: string
  passage: string
  vr: boolean
  category: string
}
export function yuanbaoPages(raw: unknown): YuanbaoPage[] {
  const root = record(raw)
  const response = record(root.Response ?? record(root.response).Response)
  return (Array.isArray(response.Pages) ? response.Pages : []).flatMap((value) => {
    try {
      if (typeof value !== 'string') return []
      const page = record(JSON.parse(value))
      if (!text(page.passage) && !text(page.title)) return []
      return [
        {
          title: webText(page.title),
          site: take(webText(page.site), 40),
          date: text(page.date),
          url: text(page.url),
          passage: text(page.passage),
          vr: page.vr === true,
          category: text(page.vr_category),
        },
      ]
    } catch {
      return []
    }
  })
}
export interface YuanbaoSearchParams {
  Query: string
  Mode: 1 | 2
  Freshness?: string
  Industry?: 'gov' | 'news'
}
export interface YuanbaoSearchResult {
  raw: unknown
  pages: YuanbaoPage[]
  latencyMs: number
  edition: string | null
}
export class YuanbaoRequestError extends Error {
  constructor(
    message: string,
    readonly raw: unknown,
    readonly latencyMs: number,
    readonly edition: string | null,
  ) {
    super(message)
  }
}
export class YuanbaoClient {
  constructor(
    private deps: {
      transport: (url: string, init: RequestInit) => Promise<Response>
      now?: () => number
      timeout?: (ms: number) => AbortSignal
      /** Trusted main-process injection for the loopback network-stack check. */
      endpoints?: { tc3: string; apikey: string }
    },
  ) {}
  async search(
    params: YuanbaoSearchParams,
    credentials: YuanbaoCredentials,
  ): Promise<YuanbaoSearchResult> {
    const started = this.deps.now?.() ?? Date.now(),
      payload = JSON.stringify(params)
    const tc3 = 'secretId' in credentials
    try {
      const url = new URL(
        tc3
          ? (this.deps.endpoints?.tc3 ?? 'https://wsa.tencentcloudapi.com/')
          : (this.deps.endpoints?.apikey ?? 'https://api.wsa.cloud.tencent.com/SearchPro'),
      )
      const response = await this.deps.transport(url.href, {
        method: 'POST',
        body: payload,
        redirect: 'error',
        signal: this.deps.timeout
          ? this.deps.timeout(YUANBAO_TIMEOUT_MS)
          : AbortSignal.timeout(YUANBAO_TIMEOUT_MS),
        headers: tc3
          ? signedYuanbaoHeaders(payload, credentials, Math.floor(started / 1000), url.host)
          : {
              'Content-Type': 'application/json; charset=utf-8',
              Authorization: `Bearer ${credentials.apiKey}`,
            },
      })
      const reader = response.body?.getReader()
      if (!reader) throw Error(yuanbaoError(undefined, response.status))
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.length
          if (bytes > YUANBAO_MAX_BYTES) throw Error('连接失败')
          chunks.push(value)
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw Error(yuanbaoError(undefined, response.status))
      }
      const raw = sanitizeYuanbaoResponse(decoded, credentials)
      const body = record(record(raw).Response),
        error = record(body.Error)
      const edition = ['lite', 'standard', 'flagship'].includes(text(body.Version))
        ? text(body.Version)
        : null
      if (!response.ok || error.Code)
        throw new YuanbaoRequestError(
          yuanbaoError(error.Code, response.status),
          raw,
          Math.max(0, (this.deps.now?.() ?? Date.now()) - started),
          edition,
        )
      // No `Pages` means the search found nothing (e.g. no vertical card right now): an empty result,
      // not a connection failure. The parsers then report 「未找到…」 for that topic.
      return {
        raw,
        pages: sanitizeYuanbaoResponse(yuanbaoPages(raw), credentials) as YuanbaoPage[],
        latencyMs: Math.max(0, (this.deps.now?.() ?? Date.now()) - started),
        edition,
      }
    } catch (error) {
      if (error instanceof YuanbaoRequestError) throw error
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError'))
        throw Error('请求超时')
      const message = error instanceof Error ? error.message : ''
      throw Error(
        [
          '密钥错误',
          '未开通或额度用完',
          '限流，稍后再试',
          '参数不被当前版本支持',
          '请求超时',
        ].includes(message) || message.startsWith('服务暂不可用（')
          ? message
          : '连接失败',
      )
    }
  }
}

export function parsePassage(passage: string): {
  top: Record<string, string>
  blocks: Record<string, string>[]
} {
  const top: Record<string, string> = {},
    blocks: Record<string, string>[] = []
  let block: Record<string, string> = {}
  const flush = () => {
    if (Object.keys(block).length) blocks.push(block)
    block = {}
  }
  for (const line of passage.split(/\r?\n/)) {
    if (!line.trim()) {
      flush()
      continue
    }
    const match = /^(#\s*)?([^：:\n]+)[：:](.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[2]!.trim(),
      value = match[3]!.trim()
    if (
      ['__proto__', 'constructor', 'prototype'].includes(key) ||
      value.endsWith('...') ||
      value.endsWith('…')
    )
      continue
    if (match[1]) {
      flush()
      top[key] = value
    } else block[key] = value
  }
  flush()
  return { top, blocks }
}

const zoneFormat = new Map<string, Intl.DateTimeFormat>()
export function zonedParts(now: number, zone = 'Asia/Shanghai') {
  let format = zoneFormat.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    zoneFormat.set(zone, format)
  }
  const parts = Object.fromEntries(format.formatToParts(now).map((part) => [part.type, part.value]))
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    date: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  }
}
function previousDay(day: string): string {
  return new Date(Date.parse(day + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10)
}
function weekday(day: string): boolean {
  const dayOfWeek = new Date(day + 'T00:00:00Z').getUTCDay()
  return dayOfWeek >= 1 && dayOfWeek <= 5
}
export function quoteTradingTime(
  topic: 'gold' | 'stock',
  symbol: string,
  now: number,
  holidays: HolidayTable,
): boolean {
  const market = symbol.split('.').at(-1)
  const parts = zonedParts(
    now,
    market === 'us' ? 'America/New_York' : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai',
  )
  const minute = parts.hour * 60 + parts.minute
  const cnDay = (date: string) => weekday(date) && !holidays[date]?.isOffDay
  if (topic === 'gold') {
    if (minute < 150) return cnDay(previousDay(parts.day))
    return cnDay(parts.day) && ((minute >= 540 && minute < 930) || minute >= 1200)
  }
  if (!weekday(parts.day)) return false
  if (market === 'us') return minute >= 570 && minute < 960
  if (market === 'hk') return (minute >= 570 && minute < 720) || (minute >= 780 && minute < 960)
  return cnDay(parts.day) && ((minute >= 570 && minute < 690) || (minute >= 780 && minute < 900))
}
export function holidayWatchYear(now: number): number | null {
  const { year, month } = zonedParts(now)
  return month >= 10 ? year + 1 : month === 1 ? year : null
}
function sourceTime(value: string, now: number, zone = 'Asia/Shanghai'): number {
  if (/^\d{10,13}$/.test(value)) return Number(value) * (value.length === 10 ? 1000 : 1)
  if (/(Z|[+-]\d\d:\d\d)$/i.test(value)) return Date.parse(value)
  const date = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(
    value,
  )
  const epoch = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    second: number,
  ) => {
    const target = Date.UTC(year, month - 1, day, hour, minute, second),
      checked = new Date(target)
    if (
      checked.getUTCFullYear() !== year ||
      checked.getUTCMonth() !== month - 1 ||
      checked.getUTCDate() !== day ||
      checked.getUTCHours() !== hour ||
      checked.getUTCMinutes() !== minute ||
      checked.getUTCSeconds() !== second
    )
      return NaN
    let guess = target
    for (let i = 0; i < 3; i++) {
      const parts = zonedParts(guess, zone)
      guess +=
        target -
        Date.UTC(parts.year, parts.month - 1, parts.date, parts.hour, parts.minute, parts.second)
    }
    return guess
  }
  if (date)
    return epoch(
      Number(date[1]),
      Number(date[2]),
      Number(date[3]),
      Number(date[4] ?? 0),
      Number(date[5] ?? 0),
      Number(date[6] ?? 0),
    )
  {
    const partial = /(?:(\d{1,2})月)?(\d{1,2})日(\d{1,2}):(\d{2})/.exec(value.replace(/\s/g, ''))
    if (!partial) return NaN
    const parts = zonedParts(now, zone)
    let year = parts.year,
      month = Number(partial[1] ?? parts.month)
    let result = epoch(year, month, Number(partial[2]), Number(partial[3]), Number(partial[4]), 0)
    if (!Number.isFinite(result) || result > now + 300000) {
      if (partial[1]) year--
      else if (--month === 0) {
        month = 12
        year--
      }
      result = epoch(year, month, Number(partial[2]), Number(partial[3]), Number(partial[4]), 0)
    }
    return result
  }
}
function cleanNumber(value: string | undefined): string {
  if (value === undefined || !/^[+-]?\d+(?:\.\d+)?%?$/.test(value.trim())) return '—'
  return value.trim()
}
function safeUrl(value: string): string {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : ''
  } catch {
    return ''
  }
}
function makeCard(
  topic: YuanbaoTopic,
  id: string,
  body: string,
  page: YuanbaoPage | undefined,
  publishedAt: number,
  fetchedAt: number,
  valid = true,
): AmbientCard {
  return {
    id,
    kind: ['weather', 'gold', 'stock'].includes(topic) ? 'life' : 'search',
    topic,
    source: `元宝搜索 · ${page?.site || '搜索结果'}`,
    text: take(webText(body), 120),
    url: safeUrl(page?.url ?? ''),
    publishedAt,
    // TTL bounds our observation; the provider timestamp stays intact, including a market's last quote.
    expiresAt: fetchedAt + YUANBAO_TTL_MS[topic],
    score: valid ? 1 : 0,
  }
}
function quoteChange(fields: Record<string, string>) {
  const direction =
    fields['涨跌状态'] === 'up'
      ? '↑'
      : fields['涨跌状态'] === 'down'
        ? '↓'
        : fields['涨跌状态'] === 'draw'
          ? '→'
          : Number(fields['涨跌额']) > 0
            ? '↑'
            : Number(fields['涨跌额']) < 0
              ? '↓'
              : '→'
  const percent = cleanNumber(fields['涨跌幅'])
  return `${direction}${percent === '—' ? '—' : percent.replace(/^[+-]/, '') + (percent.endsWith('%') ? '' : '%')}（${cleanNumber(fields['涨跌值'] ?? fields['涨跌额'])}）`
}
export function weatherCard(
  pages: YuanbaoPage[],
  city: string,
  now: number,
): AmbientCard | undefined {
  const today = zonedParts(now).day,
    tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
  const candidates = pages
    .filter((page) => page.vr && page.category === 'weather')
    .sort(
      (a, b) =>
        Number(/^#\s*天气预报[：:]/m.test(b.passage) && b.url.includes('cityid')) -
        Number(/^#\s*天气预报[：:]/m.test(a.passage) && a.url.includes('cityid')),
    )
  for (const page of candidates) {
    const { top, blocks } = parsePassage(page.passage)
    const day = blocks.find((block) => block['日期'] === today)
    if (!day) continue
    const next = blocks.find((block) => block['日期'] === tomorrow)
    const range = (block?: Record<string, string>) =>
      `${cleanNumber(block?.['最低温度（摄氏度）'])}–${cleanNumber(block?.['最高温度（摄氏度）'])}℃`
    const condition = day['当天天气状态'] || day['白天天气状态'] || '—'
    if (
      condition === '—' &&
      cleanNumber(day['最低温度（摄氏度）']) === '—' &&
      cleanNumber(day['最高温度（摄氏度）']) === '—'
    )
      continue
    const wind =
      [
        day['当天风向'] || day['白天风向'] || day['风向'] || top['风向'],
        day['当天风级'] || day['白天风级'] || day['风力'] || top['风力'],
      ]
        .filter(Boolean)
        .join('') || '—'
    const updated = sourceTime(top['更新时间'] ?? page.date, now)
    const published = Number.isFinite(updated) ? updated : now
    const body = `${city} 今天 ${condition} ${range(day)} · 体感${cleanNumber(day['体感温度（摄氏度）'])}℃ · ${wind} · 湿度${cleanNumber(day['湿度'])}% · 空气${cleanNumber(day['空气质量'])} · 限行${day['尾号限行'] || '—'} · 日落${day['日落时间'] || '—'} ｜ 明天 ${next?.['当天天气状态'] || next?.['白天天气状态'] || '—'} ${range(next)}`
    return makeCard(
      'weather',
      `life:weather:${city}:${today}:${Math.floor(published / 7200000)}`,
      body,
      page,
      published,
      now,
    )
  }
  return undefined
}
export function goldCard(
  pages: YuanbaoPage[],
  brand: boolean,
  now: number,
): AmbientCard | undefined {
  const page = pages.find(
    (item) => item.vr && item.category === 'gold' && item.title.includes('今日现货黄金价格走势图'),
  )
  if (!page) return undefined
  const { top, blocks } = parsePassage(page.passage)
  const domestic = blocks.find((block) => block['价格值类型']?.includes('国内价格'))
  const international = blocks.find((block) => block['价格值类型']?.includes('国际价格'))
  if (!domestic) return undefined
  const updated = sourceTime(
    top['更新时间'] || blocks.find((block) => block['更新时间'])?.['更新时间'] || page.date,
    now,
  )
  const published = Number.isFinite(updated) ? updated : now
  let brandLine = ''
  if (brand) {
    const physical = pages.find(
      (item) => item.vr && item.category === 'gold' && item.title.includes('实物黄金价格'),
    )
    const first =
      physical &&
      parsePassage(physical.passage).blocks.find(
        (block) => block['品牌名称'] && block['价格（元）'],
      )
    if (first) brandLine = ` · ${first['品牌名称']} ${first['价格（元）']}`
  }
  return makeCard(
    'gold',
    `life:gold:${Math.floor(published / 60000)}`,
    `国内现货金 ${cleanNumber(domestic['价格'])} 元/克 ${quoteChange(domestic)} · 国际 ${cleanNumber(international?.['价格'])} 美元/盎司${brandLine}`,
    page,
    published,
    now,
    cleanNumber(domestic['价格']) !== '—',
  )
}
export function stockCard(pages: YuanbaoPage[], symbol: string, now: number): AmbientCard {
  const [code, market] = symbol.toLowerCase().split('.') as [string, string]
  for (const page of pages.filter((item) => item.vr && item.category === 'stock')) {
    for (const section of page.passage.split(/\n(?=#\s*股票[：:])/)) {
      const fields = parsePassage(section).top
      if (
        fields['股票代码']?.toLowerCase() !== code ||
        fields['股票代码前缀']?.toLowerCase() !== market
      )
        continue
      const updated = sourceTime(
        fields['更新时间'] || page.date,
        now,
        market === 'us' ? 'America/New_York' : 'Asia/Shanghai',
      )
      const published = Number.isFinite(updated) ? updated : now
      const clock = zonedParts(published, market === 'us' ? 'America/New_York' : 'Asia/Shanghai')
      const oldDay =
        clock.day !== zonedParts(now, market === 'us' ? 'America/New_York' : 'Asia/Shanghai').day
      const clockText = Number.isFinite(updated)
        ? `${oldDay ? `${clock.month}/${clock.date} ` : ''}${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`
        : '—'
      return makeCard(
        'stock',
        `life:stock:${symbol.toLowerCase()}:${Math.floor(published / 60000)}`,
        `${fields['股票名称'] || '—'} ${symbol.toUpperCase()} ${cleanNumber(fields['实时股价'])} ${quoteChange(fields)}${fields['交易状态'] || '—'} · 高 ${cleanNumber(fields['今日最高价'])} 低 ${cleanNumber(fields['今日最低价'])} · ${clockText}`,
        page,
        published,
        now,
        cleanNumber(fields['实时股价']) !== '—',
      )
    }
  }
  return makeCard(
    'stock',
    `life:stock:${symbol.toLowerCase()}:missing`,
    `未找到 ${symbol.toUpperCase()} 的行情`,
    undefined,
    now,
    now,
    false,
  )
}
function shortened(value: string, count: number): string {
  return Array.from(value).length > count ? take(value, Math.max(0, count - 1)) + '…' : value
}
function toolSentence(page: YuanbaoPage): string {
  const normalize = (value: string) => webText(value).replace(/､/g, '、')
  const heading = normalize(page.title),
    site = normalize(page.site)
  let body = normalize(page.passage)
  // Search passages often repeat the title and site before the actual article prose.
  for (let i = 0; i < 4 && heading && body.toLowerCase().startsWith(heading.toLowerCase()); i++) {
    body = body.slice(heading.length).replace(/^[\s|：:]+/, '')
    const stop = body.indexOf('。'),
      label = body.slice(0, stop).trim()
    if (stop >= 0 && stop < 40 && label && site.startsWith(label))
      body = body.slice(stop + 1).trim()
  }
  return (
    body
      .split(/(?<=[。！？!?])\s*|(?<=\.)\s+/u)
      .find((sentence) => {
        const value = sentence.trim()
        return (
          value &&
          value !== heading &&
          value !== site &&
          !/^(?:从.{0,20}说起|关注我们|免责声明|版权声明)/u.test(value)
        )
      })
      ?.trim() ?? ''
  )
}
export function toolCard(pages: YuanbaoPage[], tool: string, now: number): AmbientCard | undefined {
  const canonical = (value: string) => webText(value).replace(/\s/g, '').toLowerCase()
  const candidates = pages
    .filter(
      (page) =>
        !page.vr &&
        Boolean(safeUrl(page.url)) &&
        canonical(page.title + page.passage).includes(canonical(tool)) &&
        /(?:\bv?\d+\.\d+(?:\.\d+)?\b|版本|release|更新|发布|changelog)/i.test(
          page.title + page.passage,
        ) &&
        (!Number.isFinite(sourceTime(page.date, now)) ||
          (sourceTime(page.date, now) >= now - 3 * 86400000 &&
            sourceTime(page.date, now) <= now + 300000)) &&
        Boolean(toolSentence(page)),
    )
    .sort((a, b) => (sourceTime(b.date, now) || 0) - (sourceTime(a.date, now) || 0))
  const page = candidates[0]
  if (!page || !safeUrl(page.url)) return undefined
  const updated = sourceTime(page.date, now),
    published = Number.isFinite(updated) ? updated : now
  const prefix = `${webText(tool)} · `
  const date = Number.isFinite(updated) ? zonedParts(updated).day.slice(5) : '日期未提供'
  const suffix = `（${shortened(page.site || '网页', 16)} · ${date}）`
  const available = 120 - Array.from(prefix + suffix).length - 1
  const title = shortened(page.title, Math.min(36, Math.max(8, Math.floor(available * 0.4))))
  const sentence = shortened(toolSentence(page), Math.min(60, available - Array.from(title).length))
  return makeCard(
    'tools',
    `search:tools:${tool.toLowerCase().replace(/\s+/g, '-')}:${hash(page.url).slice(0, 16)}`,
    `${prefix}${title}：${sentence}${suffix}`,
    page,
    published,
    now,
  )
}
export function holidayCard(
  pages: YuanbaoPage[],
  year: number,
  now: number,
): AmbientCard | undefined {
  const page = pages.find((item) => {
    if (
      item.vr ||
      !item.title.includes(String(year)) ||
      !item.title.includes('节假日安排') ||
      !/国务院办公厅/.test(item.title + item.passage)
    )
      return false
    try {
      return Boolean(safeUrl(item.url)) && /(^|\.)gov\.cn$/.test(new URL(item.url).hostname)
    } catch {
      return false
    }
  })
  if (!page) return undefined
  const updated = sourceTime(page.date, now),
    published = Number.isFinite(updated) ? updated : now
  const parts = zonedParts(published)
  return makeCard(
    'holiday',
    `search:holiday:${year}`,
    `${year} 年放假安排已发布 · 国务院办公厅 · ${Number.isFinite(updated) ? `${parts.month}月${parts.date}日` : '日期未提供'} · 日历将在数据源更新后自动同步`,
    page,
    published,
    now,
  )
}
export function newsCard(pages: YuanbaoPage[], now: number): AmbientCard | undefined {
  const seen = new Set<string>()
  const top = pages
    .filter((page) => !page.vr && page.title && !seen.has(page.title) && seen.add(page.title))
    .slice(0, 3)
  if (!top.length) return undefined
  const body = top
    .map(
      (page) =>
        `${shortened(page.title.replace(/\s+--.*--.*$/, '').trim(), 28)}（${take(page.site || '网页', 8)}）`,
    )
    .join(' · ')
  return makeCard(
    'news',
    `search:news:${Math.floor(now / 10800000)}`,
    body,
    { ...top[0]!, site: [...new Set(top.map((page) => page.site || '网页'))].join('、') },
    now,
    now,
  )
}
export function yuanbaoSample(topic: YuanbaoTopic, now = Date.now()): AmbientCard {
  const samples: Record<YuanbaoTopic, string> = {
    weather:
      '北京 今天 晴 4–22℃ · 体感15℃ · 西北风3级 · 湿度32% · 空气60 · 限行4和9 · 日落17:15 ｜ 明天 — 6–12℃',
    gold: '国内现货金 852.80 元/克 ↓0.90%（-7.77）· 国际 3984.98 美元/盎司 · 周大福 1199元/克',
    stock: '腾讯控股 00700.HK 384.200 ↑1.75%（6.600）交易中 · 高 387.600 低 375.200 · 15:29',
    tools: '工具更新公告示例（非实时结果）',
    holiday: '2027 年放假安排公告示例（非实时结果）',
    news: '示例要闻一（示例站点） · 示例要闻二（示例站点）',
  }
  if (typeof topic !== 'string' || !Object.hasOwn(samples, topic)) throw Error('示例类型无效')
  return {
    ...makeCard(topic, `yuanbao-sample:${topic}`, samples[topic], undefined, now, now, false),
    source: '元宝搜索 · 示例',
  }
}
export function yuanbaoFeatureEnabled(config: YuanbaoConfig, topic: YuanbaoTopic): boolean {
  return (
    config.enabled &&
    (topic === 'weather'
      ? config.weatherEnabled
      : topic === 'gold'
        ? config.goldEnabled
        : topic === 'stock'
          ? config.stocksEnabled
          : topic === 'tools'
            ? config.toolsEnabled
            : topic === 'holiday'
              ? config.holidayEnabled
              : config.newsEnabled)
  )
}
/** Presentation changes use cached data and a new device identity, never another paid request. */
export function yuanbaoGoldPresentation(card: AmbientCard, withBrand: boolean): AmbientCard {
  if (card.kind !== 'life' || card.topic !== 'gold') return card
  const body = withBrand ? card.text : card.text.split(' · ').slice(0, 2).join(' · ')
  return { ...card, id: `${card.id}:view:${hash(body).slice(0, 12)}`, text: body }
}

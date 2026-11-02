import type {
  AmbientCard,
  AmbientConfig,
  YuanbaoStatus,
  YuanbaoTestResult,
  YuanbaoTopic,
} from '@codepulse/shared'
import type { HolidayTable } from './calendar/index.js'
import { inQuietHours } from './ambient-rules.js'
import {
  goldCard,
  holidayCard,
  holidayWatchYear,
  newsCard,
  quoteTradingTime,
  stockCard,
  toolCard,
  weatherCard,
  yuanbaoFeatureEnabled,
  yuanbaoGoldPresentation,
  YUANBAO_TTL_MS,
  YuanbaoRequestError,
  sanitizeYuanbaoResponse,
  type YuanbaoPage,
  type YuanbaoClient,
  type YuanbaoCredentials,
  type YuanbaoSearchParams,
} from './ambient-yuanbao.js'

export interface YuanbaoCache {
  version: 1
  day: string
  requests: number
  checks: Record<string, number>
  entries: { key: string; card: AmbientCard }[]
  published: Record<string, boolean>
  edition: string | null
  lastCheckedAt: number
  lastLatencyMs: number | null
  lastError: string
}
interface Dependencies {
  config: () => AmbientConfig
  credentials: () => YuanbaoCredentials | null
  client?: Pick<YuanbaoClient, 'search'>
  cache?: unknown
  now?: () => number
  holidays: () => HolidayTable
  hasYear: (year: number) => boolean
  scheduledAllowed?: () => boolean
  save: (cache: YuanbaoCache) => void
  saveLastResponse?: (raw: unknown) => void
  /** Diagnostics only (CODEPULSE_YUANBAO_DEBUG=1): every sanitized response, per topic. */
  saveDebugResponse?: (topic: string, raw: unknown) => void
  changed: () => void
}
interface Job {
  key: string
  topic: YuanbaoTopic
  value: string
  cadence: number
  params: YuanbaoSearchParams
}
const localDay = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const validCard = (value: unknown): value is AmbientCard => {
  const card = obj(value)
  return (
    (card.kind === 'life' || card.kind === 'search') &&
    typeof card.id === 'string' &&
    card.id.length <= 400 &&
    typeof card.text === 'string' &&
    Array.from(card.text).length <= 120 &&
    typeof card.source === 'string' &&
    card.source.startsWith('元宝搜索 · ') &&
    typeof card.url === 'string' &&
    Number.isFinite(card.publishedAt) &&
    Number.isFinite(card.expiresAt) &&
    typeof card.score === 'number' &&
    ['weather', 'gold', 'stock', 'tools', 'holiday', 'news'].includes(String(card.topic))
  )
}
function uniqueJobs(entries: { key: string; card: AmbientCard }[], now: number) {
  const unique = new Map<string, { key: string; card: AmbientCard }>()
  for (const entry of entries) {
    const current = unique.get(entry.key)
    const real = (card: AmbientCard) => card.score > 0 && card.expiresAt > now
    if (!current || !real(current.card) || real(entry.card)) unique.set(entry.key, entry)
  }
  return [...unique.values()].slice(-64)
}
function restore(raw: unknown, now: number): YuanbaoCache {
  const value = obj(raw)
  return {
    version: 1,
    day: typeof value.day === 'string' ? value.day : '',
    requests:
      Number.isInteger(value.requests) && Number(value.requests) >= 0 ? Number(value.requests) : 0,
    checks: Object.fromEntries(
      Object.entries(obj(value.checks)).flatMap(([key, at]) =>
        key.length < 300 && typeof at === 'number' && Number.isFinite(at)
          ? [[key, at] as const]
          : [],
      ),
    ),
    entries: uniqueJobs(
      (Array.isArray(value.entries) ? value.entries : []).flatMap((entry) => {
        const item = obj(entry)
        if (typeof item.key !== 'string' || item.key.length >= 300 || !validCard(item.card))
          return []
        const card = item.card
        return [
          {
            key: item.key,
            card: {
              id: card.id,
              kind: card.kind,
              topic: card.topic,
              text: card.text,
              source: card.source,
              url: card.url,
              publishedAt: card.publishedAt,
              expiresAt: card.expiresAt,
              score: card.score,
            },
          },
        ]
      }),
      now,
    ),
    published: Object.fromEntries(
      Object.entries(obj(value.published)).flatMap(([year, found]) =>
        /^\d{4}$/.test(year) && found === true ? [[year, true] as const] : [],
      ),
    ),
    edition: ['lite', 'standard', 'flagship'].includes(String(value.edition))
      ? String(value.edition)
      : null,
    lastCheckedAt: typeof value.lastCheckedAt === 'number' ? value.lastCheckedAt : 0,
    lastLatencyMs: typeof value.lastLatencyMs === 'number' ? value.lastLatencyMs : null,
    // Cache text is not trusted as a public error message.
    lastError: '',
  }
}
export class YuanbaoSource {
  private cache: YuanbaoCache
  private queue: Promise<unknown> = Promise.resolve()
  private collecting = false
  private stopped = false
  private generation = 0
  private credentialTag: string
  private errors: Record<string, string> = {}
  private inputKeys: Set<string>
  private inputReadyAt: Partial<Record<YuanbaoTopic, number>> = {}
  constructor(private deps: Dependencies) {
    this.cache = restore(sanitizeYuanbaoResponse(deps.cache, deps.credentials() ?? {}), this.now())
    this.credentialTag = this.credentialsTag()
    this.inputKeys = new Set(this.jobs().map((job) => job.key))
  }
  private credentialsTag(): string {
    const key = this.deps.credentials()
    return JSON.stringify(
      key ? ('apiKey' in key ? [key.apiKey] : [key.secretId, key.secretKey]) : null,
    )
  }
  private now() {
    return this.deps.now?.() ?? Date.now()
  }
  private resetDay() {
    const day = localDay(this.now())
    if (day !== this.cache.day) {
      this.cache.day = day
      this.cache.requests = 0
    }
  }
  private persist() {
    this.deps.save(structuredClone(this.cache))
  }
  private changed() {
    try {
      this.deps.changed()
    } catch {
      /* Closing renderers do not affect collection. */
    }
  }
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action)
    this.queue = pending.then(
      () => undefined,
      () => undefined,
    )
    return pending
  }
  private jobs(): Job[] {
    const config = this.deps.config().yuanbao,
      jobs: Job[] = []
    const add = (
      topic: YuanbaoTopic,
      value: string,
      cadence: number,
      params: YuanbaoSearchParams,
    ) => jobs.push({ key: `${topic}:${value}`, topic, value, cadence, params })
    add('weather', config.city, 7200000, { Query: `${config.city}今天天气`, Mode: 1 })
    add('gold', '', 3600000, { Query: '今日金价', Mode: 1 })
    for (const symbol of config.stocks)
      add('stock', symbol, 3600000, {
        Query: `${symbol.split('.')[0]!.toUpperCase()}股价`,
        Mode: 1,
      })
    for (const tool of config.tools)
      add('tools', tool, 43200000, { Query: `${tool} 更新 发布 版本`, Mode: 2, Freshness: 'd3' })
    const year = holidayWatchYear(this.now())
    if (year !== null)
      add('holiday', String(year), 86400000, {
        Query: `${year}年部分节假日安排的通知 国务院办公厅`,
        Mode: 2,
        Industry: 'gov',
        Freshness: 'm3',
      })
    add('news', config.newsTopic, 10800000, {
      Query: config.newsTopic,
      Mode: 2,
      Industry: 'news',
      Freshness: 'd1',
    })
    return jobs
  }
  cards(): AmbientCard[] {
    const now = this.now(),
      config = this.deps.config().yuanbao
    const keys = new Set(this.jobs().map((job) => job.key))
    const latest = new Map<string, { key: string; card: AmbientCard }>()
    for (const entry of this.cache.entries
      .filter(
        (entry) =>
          entry.card.expiresAt > now &&
          entry.card.publishedAt <= now + 300000 &&
          keys.has(entry.key) &&
          !(entry.card.topic === 'holiday' && this.deps.hasYear(Number(entry.key.split(':')[1]))),
      )
      .filter(
        (entry) =>
          entry.card.topic !== 'stock' ||
          config.stocks.some((symbol) => entry.card.id.startsWith(`life:stock:${symbol}:`)),
      )) {
      if ((latest.get(entry.key)?.card.publishedAt ?? -Infinity) <= entry.card.publishedAt)
        latest.set(entry.key, entry)
    }
    return [...latest.values()].map((entry) => this.present(entry.card))
  }
  present(card: AmbientCard): AmbientCard {
    if (card.kind !== 'life' || card.topic !== 'gold') return card
    const raw = this.cache.entries.find(
      (entry) => card.id === entry.card.id || card.id.startsWith(entry.card.id + ':view:'),
    )?.card
    return raw ? yuanbaoGoldPresentation(raw, this.deps.config().yuanbao.goldBrand) : card
  }
  accepts(card: AmbientCard): boolean {
    const keys = new Set(this.jobs().map((job) => job.key))
    return this.cache.entries.some(
      (entry) =>
        (entry.card.id === card.id ||
          (entry.card.topic === 'gold' && card.id.startsWith(entry.card.id + ':view:'))) &&
        keys.has(entry.key),
    )
  }
  snapshot(): YuanbaoStatus {
    this.resetDay()
    const key = this.deps.credentials(),
      config = this.deps.config().yuanbao,
      year = holidayWatchYear(this.now())
    const sources = [
      ...new Set(
        this.cards().flatMap((card) => card.source.slice('元宝搜索 · '.length).split('、')),
      ),
    ]
    const errors: YuanbaoStatus['errors'] = {}
    for (const job of this.jobs()) {
      if (this.errors[job.key]) errors[job.topic] = this.errors[job.key]
    }
    return {
      hasKey: Boolean(key),
      authMode: key ? ('apiKey' in key ? 'apikey' : 'tc3') : null,
      requestsToday: this.cache.requests,
      limit: config.dailyRequestLimit,
      lastLatencyMs: this.cache.lastLatencyMs,
      lastError: this.cache.lastError,
      errors,
      lastCheckedAt: this.cache.lastCheckedAt,
      edition: this.cache.edition,
      sources,
      holiday:
        year === null
          ? null
          : {
              year,
              state: this.deps.hasYear(year)
                ? 'synced'
                : this.cache.published[year]
                  ? 'published'
                  : 'pending',
            },
    }
  }
  credentialsChanged(): void {
    const tag = this.credentialsTag()
    if (tag === this.credentialTag) return
    this.credentialTag = tag
    this.generation++
    // Key saves are not paid validation. Keep resource history and defer a full scheduled batch.
    this.cache.checks['@credentials'] = this.now()
    this.errors = {}
    this.cache.lastError = ''
    this.cache.lastLatencyMs = null
    this.cache.lastCheckedAt = 0
    this.cache.edition = null
    try {
      this.persist()
    } catch {
      this.cache.lastError = '本地记录无法保存'
    }
    this.changed()
  }
  stop(): void {
    this.stopped = true
    this.generation++
  }
  start(): void {
    this.stopped = false
  }
  private allowed(job: Job): boolean {
    const config = this.deps.config()
    if (
      this.stopped ||
      !config.enabled ||
      this.deps.scheduledAllowed?.() === false ||
      this.now() < (this.inputReadyAt[job.topic] ?? -Infinity) ||
      !this.deps.credentials() ||
      !yuanbaoFeatureEnabled(config.yuanbao, job.topic) ||
      inQuietHours(config, this.now())
    )
      return false
    if (job.topic === 'holiday' && this.deps.hasYear(Number(job.value))) return false
    if (!this.jobs().some((current) => current.key === job.key)) return false
    return (
      (job.topic !== 'gold' && job.topic !== 'stock') ||
      quoteTradingTime(job.topic, job.value, this.now(), this.deps.holidays())
    )
  }
  tick(): Promise<void> {
    if (this.stopped || this.collecting) return Promise.resolve()
    this.collecting = true
    return (async () => {
      const previousCount = this.cache.entries.length
      this.cache.entries = this.cache.entries
        .filter((entry) => entry.card.expiresAt > this.now())
        .slice(-64)
      if (previousCount !== this.cache.entries.length) {
        this.persist()
        this.changed()
      }
      // New city/tool/topic values inherit their topic's cadence. Capture the baseline so
      // an initial batch may still collect every configured stock or tool once.
      const checks = { ...this.cache.checks }
      const jobs = this.jobs()
      // Let debounced text edits settle, even before the first check. No extra timer or request.
      for (const job of jobs) {
        if (!this.inputKeys.has(job.key)) this.inputReadyAt[job.topic] = this.now() + 2000
      }
      this.inputKeys = new Set(jobs.map((job) => job.key))
      for (const job of jobs) {
        // Yield the queue after each request, so a manual connection test does not wait for a whole batch.
        await this.serial(async () => {
          this.resetDay()
          if (
            !this.allowed(job) ||
            this.cache.requests >= this.deps.config().yuanbao.dailyRequestLimit
          )
            return
          // A key change never refires work that already ran (re-saving a key must not spend a
          // round), but a job that has never been checked runs once its inputs have settled, so a
          // newly enabled feature shows content without waiting a full cadence.
          const history = Math.max(
            this.cache.checks[job.key] ?? -Infinity,
            ...Object.entries(checks)
              .filter(([key]) => key.startsWith(job.topic + ':'))
              .map(([, at]) => at),
          )
          const checked = Number.isFinite(history)
            ? Math.max(history, this.cache.checks['@credentials'] ?? -Infinity)
            : -Infinity
          const due =
            job.topic === 'holiday'
              ? !Number.isFinite(checked) || localDay(checked) !== localDay(this.now())
              : this.now() - checked >= job.cadence
          if (due) await this.request(job, false)
        })
      }
    })()
      .catch(() => {
        this.cache.lastError = '本地记录无法保存'
        this.changed()
      })
      .finally(() => {
        this.collecting = false
      })
  }
  async test(): Promise<YuanbaoTestResult> {
    return this.serial(async () => {
      const job = this.jobs().find((item) => item.topic === 'weather')!
      return this.request(job, true)
    })
  }
  private recordError(job: Job, manual: boolean, error: string): void {
    if (manual) this.cache.lastError = error
    if (!error) delete this.errors[job.key]
    else if (!manual) this.errors[job.key] = error
  }
  private async request(job: Job, manual: boolean): Promise<YuanbaoTestResult> {
    this.resetDay()
    const key = this.deps.credentials()
    const failed = (error: string, report = true): YuanbaoTestResult => {
      if (manual && report) this.cache.lastError = error
      return {
        ok: false,
        latencyMs: this.cache.lastLatencyMs,
        edition: this.cache.edition,
        cardText: '',
        error,
      }
    }
    if (this.stopped) return failed('服务已停止')
    if (!key) return failed('请先填写元宝搜索密钥')
    if (this.cache.requests >= this.deps.config().yuanbao.dailyRequestLimit)
      return failed('今日调用已达上限')
    if (!manual && !this.allowed(job)) return failed('当前未启用')
    const oldRequests = this.cache.requests,
      oldCheck = this.cache.checks[job.key],
      generation = this.generation
    this.cache.requests++
    this.cache.checks[job.key] = this.now()
    try {
      this.persist()
    } catch {
      this.cache.requests = oldRequests
      if (oldCheck === undefined) delete this.cache.checks[job.key]
      else this.cache.checks[job.key] = oldCheck
      this.cache.lastError = '本地记录无法保存'
      this.changed()
      return failed(this.cache.lastError)
    }
    const started = this.now()
    this.cache.lastCheckedAt = started
    this.changed()
    try {
      if (!this.deps.client) throw Error('连接失败')
      const result = await this.deps.client.search(job.params, key)
      if (this.stopped || generation !== this.generation)
        return failed('设置已变化，请重新测试', false)
      this.cache.lastLatencyMs = result.latencyMs
      this.cache.edition = ['lite', 'standard', 'flagship'].includes(String(result.edition))
        ? result.edition
        : null
      try {
        this.deps.saveDebugResponse?.(job.topic, sanitizeYuanbaoResponse(result.raw, key))
      } catch {
        /* Diagnostics must never affect a paid response. */
      }
      if (manual) {
        try {
          this.deps.saveLastResponse?.(sanitizeYuanbaoResponse(result.raw, key))
        } catch {
          /* Optional article export must not discard a successful paid response. */
        }
      }
      const now = this.now()
      const pages = sanitizeYuanbaoResponse(result.pages, key) as YuanbaoPage[]
      const parsed =
        job.topic === 'weather'
          ? weatherCard(pages, job.value, now)
          : job.topic === 'gold'
            ? goldCard(pages, true, now)
            : job.topic === 'stock'
              ? stockCard(pages, job.value, now)
              : job.topic === 'tools'
                ? toolCard(pages, job.value, now)
                : job.topic === 'holiday'
                  ? holidayCard(pages, Number(job.value), now)
                  : newsCard(pages, now)
      const card = parsed ? { ...parsed, expiresAt: now + YUANBAO_TTL_MS[job.topic] } : undefined
      const real = this.cache.entries.find(
        (entry) => entry.key === job.key && entry.card.score > 0 && entry.card.expiresAt > now,
      )
      if (card && (card.score > 0 || !real)) {
        this.cache.entries = [
          ...this.cache.entries.filter((entry) => entry.key !== job.key),
          { key: job.key, card },
        ]
          .filter((entry) => entry.card.expiresAt > now)
          .slice(-64)
        if (job.topic === 'holiday') this.cache.published[job.value] = true
      }
      const error = card
        ? card.score > 0
          ? ''
          : card.text
        : job.topic === 'holiday'
          ? ''
          : job.topic === 'tools'
            ? `近 3 天没有找到 ${job.value} 的更新`
            : '未找到可解析的数据'
      this.recordError(job, manual, error)
      this.persist()
      return {
        ok: Boolean(card && card.score > 0),
        latencyMs: result.latencyMs,
        edition: result.edition,
        cardText: card?.text ?? '',
        error,
      }
    } catch (error) {
      if (this.stopped || generation !== this.generation)
        return failed('设置已变化，请重新测试', false)
      this.cache.lastLatencyMs =
        error instanceof YuanbaoRequestError ? error.latencyMs : Math.max(0, this.now() - started)
      if (error instanceof YuanbaoRequestError) {
        this.cache.edition = error.edition
        if (manual) {
          try {
            this.deps.saveLastResponse?.(error.raw)
          } catch {
            /* The response is optional; quota is already durable. */
          }
        }
      }
      const message = error instanceof Error ? error.message : ''
      const publicError =
        [
          '密钥错误',
          '未开通或额度用完',
          '限流，稍后再试',
          '参数不被当前版本支持',
          '请求超时',
        ].includes(message) || message.startsWith('服务暂不可用（')
          ? message
          : '连接失败'
      this.recordError(job, manual, publicError)
      try {
        this.persist()
      } catch {
        /* Reservation was already saved before sending. */
      }
      return failed(publicError)
    } finally {
      this.changed()
    }
  }
}

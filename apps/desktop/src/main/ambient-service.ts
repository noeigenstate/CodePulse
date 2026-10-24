import {
  normalizeAmbient,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type StatusSnapshot,
} from '@codepulse/shared'
import { contentKey, pauseReason, qualifies, xMinimumLikes } from './ambient-rules.js'
import { collectMemes, collectX, type JsonRequest } from './ambient-sources.js'

export interface AmbientHistory {
  day: string
  shown: number
  lastShown: number
  seen: Record<string, number>
  xRequests?: number
  lastKind?: AmbientCard['kind']
}
export interface AmbientDependencies {
  config?: unknown
  history?: AmbientHistory
  status: () => StatusSnapshot
  now?: () => number
  key: (provider: AmbientConfig['provider']) => string
  save: (config: AmbientConfig, history: AmbientHistory) => void
  request: JsonRequest
  image: (url: string) => Promise<string>
  changed: () => void
}
const day = (now: number) => {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}
export class AmbientService {
  private config: AmbientConfig
  private history: AmbientHistory
  private cards: AmbientCard[] = []
  private active: AmbientCard | undefined
  private activeUntil = 0
  private timer?: ReturnType<typeof setInterval>
  private collecting = false
  private lastCheckedAt = 0
  private nextCheckAt = 0
  private generation = 0
  private stopped = false
  private errors = { x: '尚未检查', meme: '尚未检查' }
  constructor(private deps: AmbientDependencies) {
    this.config = normalizeAmbient(deps.config)
    this.history =
      deps.history &&
      typeof deps.history.day === 'string' &&
      Number.isFinite(deps.history.shown) &&
      Number.isFinite(deps.history.lastShown) &&
      deps.history.seen &&
      typeof deps.history.seen === 'object'
        ? deps.history
        : { day: '', shown: 0, lastShown: 0, seen: {} }
  }
  private now() {
    return this.deps.now?.() ?? Date.now()
  }
  private changed() {
    try {
      this.deps.changed()
    } catch {
      /* A closing view must not interrupt agent status handling. */
    }
  }
  private persist() {
    this.deps.save(this.config, this.history)
  }
  private resetDay() {
    const today = day(this.now())
    if (today !== this.history.day) {
      this.history.day = today
      this.history.shown = 0
      this.history.xRequests = 0
    }
    this.history.seen = Object.fromEntries(
      Object.entries(this.history.seen)
        .filter(([, t]) => Number.isFinite(t) && t > this.now() - 7 * 86400000)
        .slice(-512),
    )
  }
  start() {
    this.stopped = false
    this.timer ??= setInterval(() => this.tick(), 15000)
    this.timer.unref?.()
    this.tick()
  }
  stop() {
    this.stopped = true
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
  getConfig() {
    return this.config
  }
  configure(input: unknown) {
    const config = normalizeAmbient(input)
    this.deps.save(config, this.history) // Do not apply unsaved settings on failure.
    this.config = config
    this.generation++
    this.cards = []
    this.active = undefined
    this.nextCheckAt = 0
    this.changed()
    return this.snapshot()
  }
  snapshot(): AmbientSnapshot {
    this.resetDay()
    return {
      config: this.config,
      hasKey: Boolean(this.deps.key(this.config.provider)),
      collecting: this.collecting,
      lastCheckedAt: this.lastCheckedAt,
      nextCheckAt: this.nextCheckAt,
      sourceStatus: {
        x: !this.config.xEnabled
          ? '已关闭'
          : !this.deps.key(this.config.provider)
            ? '待配置 API 密钥'
            : (this.history.xRequests ?? 0) >= this.config.dailyRequestLimit
              ? '今日 X 检查已达上限'
              : this.errors.x,
        meme: !this.config.memeEnabled ? '已关闭' : this.errors.meme,
      },
      cards: this.cards.filter((c) => c.expiresAt > this.now()),
      activeId: this.current()?.id ?? null,
      shownToday: this.history.shown,
      xRequestsToday: this.history.xRequests ?? 0,
      pausedReason:
        pauseReason(this.config, this.deps.status(), this.now()) ||
        (this.history.shown >= this.config.dailyLimit ? '今日展示已达上限' : '') ||
        (!this.current() &&
        this.history.lastShown &&
        this.now() - this.history.lastShown < this.config.gapMinutes * 60000
          ? '展示间隔中，稍后自动展示'
          : ''),
    }
  }
  current(status = this.deps.status()): AmbientCard | undefined {
    return this.active &&
      this.activeUntil > this.now() &&
      this.active.expiresAt > this.now() &&
      !pauseReason(this.config, status, this.now())
      ? this.active
      : undefined
  }
  dismiss() {
    this.active = undefined
    this.changed()
    return this.snapshot()
  }
  show(id?: string) {
    this.resetDay()
    if (
      pauseReason(this.config, this.deps.status(), this.now()) ||
      this.history.shown >= this.config.dailyLimit ||
      this.now() - this.history.lastShown < this.config.gapMinutes * 60000
    )
      return this.snapshot()
    const available = this.cards.filter(
      (c) =>
        (!id || c.id === id) &&
        qualifies(c, this.config, this.now()) &&
        !this.history.seen[c.id] &&
        !this.history.seen[contentKey(c)],
    )
    const card = available.find((c) => c.kind !== this.history.lastKind) ?? available[0]
    if (!card) return this.snapshot()
    const previous = structuredClone(this.history)
    this.history.seen[card.id] = this.history.seen[contentKey(card)] = this.now()
    this.history.shown++
    this.history.lastShown = this.now()
    this.history.lastKind = card.kind
    try {
      this.persist()
    } catch {
      this.history = previous
      return this.snapshot()
    }
    this.active = card
    this.activeUntil = this.now() + this.config.displayMinutes * 60000
    this.changed()
    return this.snapshot()
  }
  tick() {
    if (this.stopped) return
    this.resetDay()
    if (this.active && !this.current()) {
      this.active = undefined
      this.changed()
    }
    if (
      !this.config.enabled ||
      this.history.shown >= this.config.dailyLimit ||
      pauseReason(this.config, this.deps.status(), this.now()) === '安静时段'
    )
      return
    if (this.now() >= this.nextCheckAt) void this.refresh()
    if (!this.active) this.show()
  }
  async refresh(): Promise<AmbientSnapshot> {
    if (
      !this.config.enabled ||
      this.collecting ||
      this.stopped ||
      this.now() < this.lastCheckedAt + 60000
    )
      return this.snapshot()
    const config = this.config,
      generation = this.generation,
      now = this.now()
    this.collecting = true
    this.lastCheckedAt = now
    this.nextCheckAt = now + config.pollMinutes * 60000
    this.changed()
    try {
      this.resetDay()
      let fetchX =
        config.xEnabled &&
        config.accounts.length > 0 &&
        Boolean(this.deps.key(config.provider)) &&
        (this.history.xRequests ?? 0) < config.dailyRequestLimit
      if (fetchX) {
        const previous = this.history.xRequests ?? 0
        this.history.xRequests = previous + 1
        try {
          this.persist()
        } catch {
          this.history.xRequests = previous
          fetchX = false
          this.errors.x = '本地记录无法保存，已暂停付费检查'
        }
      }
      const results = await Promise.allSettled([
        fetchX
          ? collectX(config, this.deps.key(config.provider), now, this.deps.request)
          : Promise.resolve([]),
        config.memeEnabled ? collectMemes(config, now, this.deps.request) : Promise.resolve([]),
      ])
      if (generation !== this.generation || this.stopped) return this.snapshot()
      const incoming: AmbientCard[] = []
      for (const [index, result] of results.entries()) {
        const source = index === 0 ? 'x' : 'meme'
        if (source === 'x' && !fetchX) continue
        if (result.status === 'rejected') {
          this.errors[source] =
            result.reason instanceof Error &&
            /^(访问被拒绝|来源限流|来源暂不可用|数据源返回|X 返回|meme 来源)/.test(
              result.reason.message,
            )
              ? result.reason.message
              : '连接失败，稍后自动重试'
          continue
        }
        const filtered = result.value.filter(
          (c) =>
            qualifies(c, config, now) &&
            !this.history.seen[c.id] &&
            !this.history.seen[contentKey(c)],
        )
        this.errors[source] = filtered.length
          ? `找到 ${filtered.length} 条候选`
          : '本轮没有合适内容'
        incoming.push(...filtered)
      }
      const unique = new Map<string, AmbientCard>()
      for (const card of [...this.cards, ...incoming].filter(
        (c) =>
          qualifies(c, config, now) &&
          (c.id === this.active?.id ||
            (!this.history.seen[c.id] && !this.history.seen[contentKey(c)])),
      ))
        unique.set(contentKey(card), card)
      const candidates = [...unique.values()]
        .sort(
          (a, b) =>
            b.score /
              (b.kind === 'x'
                ? Math.max(1, xMinimumLikes(config, b.source))
                : Math.max(1, config.memeMinUps)) -
            a.score /
              (a.kind === 'x'
                ? Math.max(1, xMinimumLikes(config, a.source))
                : Math.max(1, config.memeMinUps)),
        )
        .slice(0, 12)
      let imagesPrepared = 0
      for (const card of candidates.filter((c) => c.kind === 'meme' && !c.imageHex).slice(0, 3)) {
        try {
          card.imageHex = await this.deps.image(card.imageUrl!)
          if (++imagesPrepared === 2) break
        } catch {
          this.errors.meme = '图片读取失败，稍后重试'
        }
      }
      if (imagesPrepared) this.errors.meme = `已准备 ${imagesPrepared} 张图片`
      if (generation === this.generation && !this.stopped)
        this.cards = candidates.filter((c) => c.kind === 'x' || c.imageHex)
    } finally {
      this.collecting = false
      if (!this.stopped) this.changed()
    }
    if (generation === this.generation && !this.stopped && !this.active) this.show()
    return this.snapshot()
  }
}

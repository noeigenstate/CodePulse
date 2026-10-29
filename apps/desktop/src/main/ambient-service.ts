import {
  normalizeAmbient,
  hudStateLevel,
  type AmbientCard,
  type AmbientConfig,
  type AmbientSnapshot,
  type StatusSnapshot,
} from '@codepulse/shared'
import { contentKey, pauseReason, qualifies, xMinimumLikes } from './ambient-rules.js'
import { builtinCards, restorePersonalCards, personalCard } from './ambient-library.js'
import { petCards } from './ambient-pet.js'
import { collectMemes, collectX, collectNews, type JsonRequest } from './ambient-sources.js'

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
  library?: unknown
  saveLibrary?: (cards: AmbientCard[]) => void
  automaticAllowed?: () => boolean
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
  private manual = false
  private personal: AmbientCard[] = []
  private timer?: ReturnType<typeof setInterval>
  private collecting = false
  private lastCheckedAt = 0
  private nextCheckAt = 0
  private generation = 0
  private stopped = false
  private errors = { x: '尚未检查', meme: '尚未检查', news: '尚未检查' }
  constructor(private deps: AmbientDependencies) {
    this.config = normalizeAmbient(deps.config)
    this.personal = restorePersonalCards(deps.library, this.now())
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
    if (!this.manual) this.active = undefined
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
        news: !this.config.newsEnabled ? '已关闭' : this.errors.news,
      },
      cards: this.allCards(),
      activeId: this.current()?.id ?? null,
      shownToday: this.history.shown,
      xRequestsToday: this.history.xRequests ?? 0,
      pausedReason:
        (this.deps.automaticAllowed?.() === false ? '控制中当前为工作画面；仍可手动展示' : '') ||
        pauseReason(this.config, this.deps.status(), this.now()) ||
        (this.history.shown >= this.config.dailyLimit ? '今日展示已达上限' : '') ||
        (!this.current() &&
        this.history.lastShown &&
        this.now() - this.history.lastShown < this.config.gapMinutes * 60000
          ? '展示间隔中，稍后自动展示'
          : ''),
    }
  }
  current(status = this.deps.status()): (AmbientCard & { manual?: true }) | undefined {
    return this.active &&
      this.activeUntil > this.now() &&
      this.active.expiresAt > this.now() &&
      !(this.manual ? this.manualPause(status) : pauseReason(this.config, status, this.now())) &&
      (this.manual || this.deps.automaticAllowed?.() !== false)
      ? this.manual
        ? { ...this.active, manual: true }
        : this.active
      : undefined
  }
  private allCards(): AmbientCard[] {
    // Pets are always listed for manual display; `qualifies` gates only the automatic showing.
    return [
      ...this.personal,
      ...this.cards,
      ...petCards(this.deps.status(), this.now()),
      ...builtinCards(this.now()),
    ].filter((c) => c.expiresAt > this.now())
  }
  private manualPause(status = this.deps.status()) {
    return status.agents.some(
      (a) => !a.taskHidden && ['action', 'fault'].includes(hudStateLevel(a)),
    )
      ? '先处理 Agent 的授权、补充输入或异常提醒'
      : ''
  }
  addPersonal(kind: 'note' | 'image', input: unknown, imageHex?: string) {
    const card = personalCard(kind, input, this.now(), imageHex)
    const next = [card, ...this.personal.filter((c) => c.id !== card.id)].slice(0, 8)
    this.deps.saveLibrary?.(next)
    this.personal = next
    this.changed()
    return card
  }
  removePersonal(id: unknown) {
    const next = this.personal.filter((c) => c.id !== id)
    this.deps.saveLibrary?.(next)
    this.personal = next
    if (this.active?.id === id) this.active = undefined
    this.changed()
    return this.snapshot()
  }
  /** Explicit display may cover passive review notices, without acknowledging them. */
  showManual(id: unknown) {
    const reason = this.manualPause()
    if (reason) throw new Error(reason + '，处理后可立即展示；现在可以先预览')
    const card = this.allCards().find((c) => c.id === id)
    if (!card) throw new Error('内容已过期，请重新选择')
    this.active = card
    this.manual = true
    this.activeUntil = this.now() + this.config.displayMinutes * 60000
    this.changed()
    return this.snapshot()
  }
  dismiss() {
    this.active = undefined
    this.changed()
    return this.snapshot()
  }
  show(id?: string) {
    this.resetDay()
    if (
      this.deps.automaticAllowed?.() === false ||
      pauseReason(this.config, this.deps.status(), this.now()) ||
      this.history.shown >= this.config.dailyLimit ||
      this.now() - this.history.lastShown < this.config.gapMinutes * 60000
    )
      return this.snapshot()
    const available = this.allCards().filter(
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
    this.manual = false
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
  async refresh(manual = false): Promise<AmbientSnapshot> {
    if (
      (!this.config.enabled && !manual) ||
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
        config.newsEnabled ? collectNews(now, this.deps.request) : Promise.resolve([]),
      ])
      if (generation !== this.generation || this.stopped) return this.snapshot()
      const incoming: AmbientCard[] = []
      for (const [index, result] of results.entries()) {
        const source = index === 0 ? 'x' : index === 1 ? 'meme' : 'news'
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
        this.cards = candidates.filter((c) => c.kind !== 'meme' || c.imageHex)
    } finally {
      this.collecting = false
      if (!this.stopped) this.changed()
    }
    if (generation === this.generation && !this.stopped && !this.active) this.show()
    return this.snapshot()
  }
}

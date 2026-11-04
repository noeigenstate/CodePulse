import {
  INK_CONNECTED_WINDOW_MS,
  normalizeInkPlan,
  inkRotationItems,
  type DeviceStatusV1,
  type InkDisplayPlan,
  type InkScreenStatus,
} from '@codepulse/shared'
import { inkFeatureAt } from './ambient-plan.js'

export function inkCardTitle(card: { source: string; text: string }): string {
  const firstLine = card.text.split(/\r?\n/)[0]?.trim() ?? ''
  return (firstLine ? `${card.source} · ${firstLine}` : card.source).slice(0, 80)
}

export interface InkStatusInput {
  plan: InkDisplayPlan
  now: number
  lastSeenAt: number | null
  serverEnabled: boolean
  /** The same final projection consumed by the LAN device and the live preview. */
  projected: Pick<DeviceStatusV1, 'ambient'>
  ambientTemporary: { title: string; until: number } | null
  assistantUntil: number
  ambientPausedReason: string
  nextAutoAt?: number | null
}

export function computeInkStatus(input: InkStatusInput): InkScreenStatus {
  const { now, lastSeenAt } = input
  const plan = normalizeInkPlan(input.plan)
  const current = inkFeatureAt(plan, now)
  const dwell = plan.intervalMinutes * 60000
  const nextAt = (Math.floor(now / dwell) + 1) * dwell
  const card = input.projected.ambient
  const kind = card?.id.startsWith('perf-') ? 'performance' : card?.items ? 'todos' : 'ambient'
  const ambient =
    input.ambientTemporary && input.ambientTemporary.until > now ? input.ambientTemporary : null
  const todo = input.assistantUntil > now ? { title: '待办', until: input.assistantUntil } : null
  // Match selectDeskContent: a manual ambient card owns the screen ahead of manual todos.
  const temporary: InkScreenStatus['temporary'] = ambient
    ? { ...ambient, kind: 'ambient' }
    : todo
      ? { ...todo, kind: 'todos' }
      : null
  const showing: InkScreenStatus['showing'] = card
    ? { kind, title: inkCardTitle(card), id: card.id }
    : { kind: 'work' }
  let slotNote = ''
  if (temporary && showing.kind === 'work') slotNote = '授权或异常提醒优先，临时展示暂停'
  else if (!temporary && current === 'ambient' && showing.kind === 'work') {
    slotNote = `桌边内容时段：${input.ambientPausedReason || '暂无可展示内容'}，暂显示工作画面`
  }
  return {
    connection: !input.serverEnabled
      ? 'server-off'
      : lastSeenAt !== null && lastSeenAt <= now && now - lastSeenAt < INK_CONNECTED_WINDOW_MS
        ? 'connected'
        : 'disconnected',
    lastSeenAt,
    showing,
    temporary,
    mode: plan.mode,
    current,
    next:
      plan.mode === 'cycle' && inkRotationItems(plan).length > 1
        ? { feature: inkFeatureAt(plan, nextAt), at: nextAt }
        : null,
    slotNote,
    updatedAt: now,
  }
}

/** One deadline timer, rescheduled on changes; countdowns never change the device revision. */
export class InkStatusRuntime {
  private timer?: ReturnType<typeof setTimeout>
  private deadline?: number
  private stopped = false
  private refreshing = false
  private input?: Omit<InkStatusInput, 'now'>
  private status?: InkScreenStatus
  private retryAt?: number
  private lastStatusReadAt?: number
  private publishedConnection?: InkScreenStatus['connection']
  private visibleKey?: string
  constructor(
    private options: {
      read: () => Omit<InkStatusInput, 'now'>
      publish: (status: InkScreenStatus) => void
      advance?: () => void
      now?: () => number
    },
  ) {}
  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private readInput(): Omit<InkStatusInput, 'now'> {
    const input = this.options.read()
    return this.lastStatusReadAt === undefined
      ? input
      : { ...input, lastSeenAt: this.lastStatusReadAt }
  }
  snapshot(): InkScreenStatus {
    return computeInkStatus({ ...this.readInput(), now: this.now() })
  }
  /** The hot long-poll path only extends the connection deadline after the first connection. */
  statusRead(at: number): void {
    if (this.stopped) return
    this.lastStatusReadAt = at
    const now = this.now()
    if (
      !this.input ||
      this.publishedConnection !== 'connected' ||
      (this.status?.next && this.status.next.at <= now) ||
      (this.status?.temporary && this.status.temporary.until <= now)
    ) {
      this.refresh()
      return
    }
    this.input = { ...this.input, lastSeenAt: at }
    this.schedule()
  }
  private schedule(retryAt?: number): void {
    if (this.stopped) return
    const now = this.now(),
      input = this.input
    if (retryAt !== undefined) this.retryAt = retryAt
    const deadlines = [
      this.status?.next?.at,
      this.status?.temporary?.until,
      // Only a future eligibility change is a useful wake-up. Critical expiry/slot timers remain exact.
      input?.nextAutoAt && input.nextAutoAt > now + 1000 ? input.nextAutoAt : undefined,
      input?.serverEnabled && input.lastSeenAt !== null && input.lastSeenAt <= now
        ? input.lastSeenAt + INK_CONNECTED_WINDOW_MS
        : undefined,
      this.retryAt,
    ].filter((at): at is number => typeof at === 'number' && at > now)
    const deadline = deadlines.length ? Math.min(...deadlines) : undefined
    if (this.timer && this.deadline === deadline) return
    clearTimeout(this.timer)
    this.timer = undefined
    this.deadline = deadline
    if (deadline === undefined) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.deadline = undefined
      this.retryAt = undefined
      let advanceFailed = false
      this.refreshing = true
      try {
        this.options.advance?.()
      } catch {
        advanceFailed = true
      } finally {
        this.refreshing = false
      }
      this.refresh()
      if (advanceFailed) this.schedule(this.now() + 1000)
    }, deadline - now)
    this.timer.unref?.()
  }
  refresh(): void {
    if (this.stopped || this.refreshing) return
    this.refreshing = true
    try {
      const now = this.now()
      const input = { ...this.readInput(), now }
      this.input = input
      const status = computeInkStatus(input)
      this.status = status
      const { updatedAt: _updatedAt, lastSeenAt: _lastSeenAt, ...visible } = status
      const key = JSON.stringify(visible)
      if (key !== this.visibleKey) {
        this.options.publish(status)
        this.visibleKey = key
        this.publishedConnection = status.connection
      }
      this.retryAt = undefined
      this.schedule()
    } catch {
      // Projection/store/view failures neither escape a hub listener nor abandon the deadline timer.
      this.schedule(this.now() + 1000)
    } finally {
      this.refreshing = false
    }
  }
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }
}

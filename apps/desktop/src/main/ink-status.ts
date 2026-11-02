import {
  INK_CONNECTED_WINDOW_MS,
  normalizeInkPlan,
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
  const kind = card?.items ? 'todos' : 'ambient'
  const ambient =
    input.ambientTemporary && input.ambientTemporary.until > now ? input.ambientTemporary : null
  const todo = input.assistantUntil > now ? { title: '待办', until: input.assistantUntil } : null
  // Manual actions clear the other service. The tie breaker also makes bootstrap/recovery deterministic.
  const temporary: InkScreenStatus['temporary'] =
    todo && (!ambient || (card?.manual && kind === 'todos') || todo.until >= ambient.until)
      ? { ...todo, kind: 'todos' }
      : ambient
        ? { ...ambient, kind: 'ambient' }
        : null
  const showing: InkScreenStatus['showing'] = card ? { kind, title: inkCardTitle(card) } : { kind: 'work' }
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
      plan.mode === 'cycle' && plan.items.length > 1
        ? { feature: inkFeatureAt(plan, nextAt), at: nextAt }
        : null,
    slotNote,
    updatedAt: now,
  }
}

/** One deadline timer, rescheduled on changes; countdowns never change the device revision. */
export class InkStatusRuntime {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  private refreshing = false
  constructor(
    private options: {
      read: () => Omit<InkStatusInput, 'now'>
      publish: (status: InkScreenStatus) => void
      advance?: () => void
      now?: () => number
    },
  ) {}
  snapshot(): InkScreenStatus {
    return computeInkStatus({ ...this.options.read(), now: this.options.now?.() ?? Date.now() })
  }
  refresh(): void {
    if (this.stopped || this.refreshing) return
    this.refreshing = true
    clearTimeout(this.timer)
    try {
      const now = this.options.now?.() ?? Date.now()
      const input = { ...this.options.read(), now }
      const status = computeInkStatus(input)
      this.options.publish(status)
      const deadlines = [
        status.next?.at,
        status.temporary?.until,
        input.nextAutoAt,
        status.connection === 'connected' && status.lastSeenAt !== null
          ? status.lastSeenAt + INK_CONNECTED_WINDOW_MS
          : null,
      ].filter((at): at is number => typeof at === 'number' && at > now)
      if (deadlines.length) {
        this.timer = setTimeout(
          () => {
            this.refreshing = true
            try {
              this.options.advance?.()
            } finally {
              this.refreshing = false
            }
            this.refresh()
          },
          Math.min(...deadlines) - now,
        )
        this.timer.unref?.()
      }
    } finally {
      this.refreshing = false
    }
  }
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
  }
}

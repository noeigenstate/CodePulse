import { createHash, randomUUID } from 'node:crypto'
import {
  DEFAULT_ASSISTANT_SETTINGS,
  hudStateLevel,
  type AssistantAction,
  type AssistantConversationTurn,
  type AssistantAudio,
  type AssistantDraft,
  type AssistantSettings,
  type AssistantSnapshot,
  type DeskTaskInput,
  type AmbientCard,
  type StatusSnapshot,
} from '@codepulse/shared'
import { AssistantStore, text } from './assistant-store.js'
import type { AssistantKeys, AssistantProvider } from './assistant-provider.js'
import { resolveReminderTime } from './assistant-time.js'

export interface AssistantDependencies {
  store: AssistantStore
  provider: AssistantProvider
  settings?: unknown
  keys: () => AssistantKeys
  save: (settings: AssistantSettings) => void
  changed: () => void
  notify: (title: string) => boolean
  now?: () => number
  automaticAllowed?: () => boolean
  restoreWork?: () => void
}
interface DraftRecord {
  draft: AssistantDraft
  applied: boolean
  revisions: Map<string, number>
}
export class AssistantService {
  private settings: AssistantSettings
  private drafts = new Map<string, DraftRecord>()
  private conversations = new Map<
    string,
    { updatedAt: number; turns: AssistantConversationTurn[] }
  >()
  private recentReminders = new Map<string, { taskId: string; title: string; at: number }>()
  private timer?: ReturnType<typeof setInterval>
  private busy = false
  private speaking = false
  private stopped = false
  private now: () => number
  private inkUntil = 0
  private dueMilestone = ''
  private error: string | null = null
  private announcements: {
    id: string
    taskId: string
    text: string
    expiresAt: number
    acked: Set<string>
    leases: Map<string, number>
  }[] = []
  constructor(private deps: AssistantDependencies) {
    this.now = deps.now ?? Date.now
    this.settings = normalizeAssistantSettings(deps.settings)
    this.announcements = deps.store
      .announcements(this.now())
      .map((a) => ({ ...a, acked: new Set(a.acked), leases: new Map() }))
  }
  snapshot(): AssistantSnapshot {
    const keys = this.deps.keys()
    const latest = [...this.drafts.values()].at(-1)
    const proposal =
      latest && !latest.applied && latest.draft.expiresAt > this.now() ? latest.draft : undefined
    return {
      ...(proposal ? { proposal } : {}),
      tasks: this.deps.store.list(),
      memories: this.deps.store.memories(),
      settings: { ...this.settings },
      credentials: {
        llmKey: Boolean(keys.llmKeys?.[this.settings.provider] ?? keys.llmKey),
        speechAppKey: Boolean(keys.speechAppKey),
        speechToken: Boolean(keys.speechToken),
      },
      busy: this.busy,
      error: this.error,
    }
  }
  configure(input: unknown): AssistantSnapshot {
    const settings = normalizeAssistantSettings(input)
    this.deps.save(settings)
    this.settings = settings
    this.emit()
    return this.snapshot()
  }
  add(input: DeskTaskInput): AssistantSnapshot {
    this.deps.store.add(input, this.now())
    this.emit()
    return this.snapshot()
  }
  update(id: string, input: DeskTaskInput): AssistantSnapshot {
    this.deps.store.update(id, input, this.now())
    this.removeAnnouncements(id)
    this.emit()
    return this.snapshot()
  }
  finish(id: string, cancelled = false): AssistantSnapshot {
    this.deps.store.finish(id, cancelled ? 'cancelled' : 'completed', this.now())
    this.removeAnnouncements(id)
    this.emit()
    return this.snapshot()
  }
  snooze(id: string, seconds: number): AssistantSnapshot {
    this.deps.store.snooze(id, seconds, this.now())
    this.removeAnnouncements(id)
    this.emit()
    return this.snapshot()
  }
  forget(id: string): AssistantSnapshot {
    this.deps.store.forget(text(id, 80, true))
    this.emit()
    return this.snapshot()
  }
  async interpret(input: unknown, conversation = 'desktop'): Promise<AssistantDraft> {
    if (this.busy || this.stopped) throw new Error('助手正在处理，请稍候')
    const value = text(input, 4000, true)
    const actor = text(conversation, 64, true)
    this.busy = true
    this.error = null
    this.emit()
    try {
      const now = this.now(),
        snapshot = this.snapshot()
      for (const [id, item] of this.conversations)
        if (now - item.updatedAt > 1800000) this.conversations.delete(id)
      const history = this.conversations.get(actor)?.turns ?? []
      const recent = this.recentReminders.get(actor)
      const recentTask =
        recent && now - recent.at <= 600000
          ? snapshot.tasks.find((t) => t.id === recent.taskId && t.status === 'pending')
          : undefined
      const plan = await this.deps.provider.plan(
        value,
        this.settings,
        snapshot.tasks,
        snapshot.memories,
        now,
        history,
        { recentReminder: recentTask ? { id: recentTask.id, title: recentTask.title } : null },
      )
      if (this.stopped) throw new Error('助手已停止')
      const tasks = plan.actions
        .filter(
          (a): a is Extract<AssistantAction, { kind: 'create_task' }> => a.kind === 'create_task',
        )
        .map((a) => ({ title: a.title, notes: a.notes, dueAt: resolveReminderTime(a, now) }))
      for (const action of plan.actions)
        if (
          'id' in action &&
          !snapshot.tasks.some((t) => t.id === action.id && t.status === 'pending')
        )
          throw new Error('待办已变化，请重新确认')
      const draft: AssistantDraft = {
        id: randomUUID(),
        reply: plan.reply,
        actions: plan.actions,
        tasks,
        expiresAt: now + 600000,
      }
      for (const [id, record] of this.drafts)
        if (record.draft.expiresAt <= now) this.drafts.delete(id)
      if (this.drafts.size >= 20) this.drafts.delete(this.drafts.keys().next().value!)
      this.drafts.set(draft.id, {
        draft,
        applied: false,
        revisions: new Map(
          plan.actions
            .filter((a): a is Extract<AssistantAction, { id: string }> => 'id' in a)
            .map((a) => [a.id, snapshot.tasks.find((t) => t.id === a.id)!.updatedAt]),
        ),
      })
      if (this.conversations.size >= 17 && !this.conversations.has(actor))
        this.conversations.delete(this.conversations.keys().next().value!)
      this.conversations.set(actor, {
        updatedAt: now,
        turns: [
          ...history,
          { role: 'user', content: value.slice(0, 800) },
          { role: 'assistant', content: plan.reply.slice(0, 800) },
        ].slice(-8) as AssistantConversationTurn[],
      })
      return draft
    } catch (error) {
      this.error = publicAssistantError(error)
      throw new Error(this.error)
    } finally {
      this.busy = false
      this.emit()
    }
  }
  apply(id: string): AssistantSnapshot {
    const record = this.drafts.get(text(id, 80, true))
    if (!record || record.draft.expiresAt <= this.now()) throw new Error('建议已过期，请重新输入')
    if (record.applied) return this.snapshot()
    for (const [taskId, revision] of record.revisions) {
      const task = this.deps.store.get(taskId)
      if (!task || task.status !== 'pending' || task.updatedAt !== revision)
        throw new Error('待办已变化，请重新生成建议')
    }
    let nextSettings = this.settings,
      index = 0
    this.deps.store.transaction(() => {
      for (const action of record.draft.actions) {
        switch (action.kind) {
          case 'create_task':
            this.deps.store.add(record.draft.tasks[index++], this.now())
            break
          case 'complete_task':
            this.deps.store.finish(action.id, 'completed', this.now())
            break
          case 'snooze_task':
            this.deps.store.snooze(action.id, action.secondsFromNow, this.now())
            break
          case 'save_memory':
            this.deps.store.remember(action.text, this.now())
            break
          case 'switch_scene':
            nextSettings = { ...nextSettings, scene: action.scene }
            break
        }
      }
      if (nextSettings !== this.settings) this.deps.save(nextSettings)
    })
    this.settings = nextSettings
    record.applied = true
    for (const action of record.draft.actions)
      if (action.kind === 'complete_task' || action.kind === 'snooze_task')
        this.removeAnnouncements(action.id)
    this.emit()
    return this.snapshot()
  }
  async transcribe(pcm: Uint8Array): Promise<string> {
    if (!this.settings.voiceInput) throw new Error('请先开启语音输入')
    if (this.busy || this.stopped) throw new Error('助手正在处理，请稍候')
    // Reserving the ASR lane prevents parallel devices from spending concurrently.
    this.busy = true
    this.emit()
    let value: string
    try {
      value = await this.deps.provider.transcribe(pcm)
    } catch (error) {
      throw new Error(publicAssistantError(error))
    } finally {
      this.busy = false
      this.emit()
    }
    return value
  }
  async listen(pcm: Uint8Array): Promise<{ text: string; draft: AssistantDraft }> {
    const value = await this.transcribe(pcm)
    return { text: value, draft: await this.interpret(value) }
  }
  async speak(input: unknown): Promise<AssistantAudio> {
    if (!this.settings.voiceOutput) throw new Error('请先开启语音输出')
    if (this.quiet(this.now())) throw new Error('当前处于安静时段')
    if (this.stopped) throw new Error('助手已停止')
    if (this.speaking) throw new Error('语音输出正在处理，请稍候')
    this.speaking = true
    try {
      const pcm = await this.deps.provider.synthesize(text(input, 300, true), this.settings.voice)
      if (!this.settings.voiceOutput || this.stopped || this.quiet(this.now()))
        throw new Error('语音输出已取消')
      return { pcm, sampleRate: 16000 }
    } catch (error) {
      throw new Error(publicAssistantError(error))
    } finally {
      this.speaking = false
    }
  }
  start(): void {
    if (this.timer) return
    this.stopped = false
    this.timer = setInterval(() => {
      try {
        this.tick()
      } catch {
        this.error = '提醒处理失败，请检查本地存储'
        this.emit()
      }
    }, 15000)
    this.timer.unref?.()
    this.tick()
  }
  stop(): void {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    this.drafts.clear()
    this.conversations.clear()
    this.recentReminders.clear()
    this.clearAnnouncements()
  }
  tick(): void {
    if (this.stopped) return
    const now = this.now()
    const due = this.deps.store.due(now),
      milestone = due.map((t) => t.id).join(',')
    let changed = milestone !== this.dueMilestone
    this.dueMilestone = milestone
    for (const task of due) {
      // Preserve LumaDesk's 30 minute catch-up window; stale reminders stay visible but never speak late.
      if (now - task.dueAt! > 1800000) {
        this.deps.store.recordReminder(task.id, 'expired', now)
        changed = true
        continue
      }
      if (this.quiet(now)) continue
      let delivered = false
      if (this.settings.notifications)
        try {
          delivered = this.deps.notify(task.title)
        } catch {
          /* retry next tick, without logging private text */
        }
      if (
        this.settings.voiceOutput &&
        !this.announcements.some((a) => a.taskId === task.id && a.expiresAt > now)
      ) {
        const item = {
          id: randomUUID(),
          taskId: task.id,
          text: task.title,
          expiresAt: task.dueAt! + 1800000,
          acked: new Set<string>(),
          leases: new Map<string, number>(),
        }
        const saved = this.deps.store.announce(item.id, item.taskId, item.text, item.expiresAt)
        this.announcements.push({ ...item, ...saved })
      }
      if (delivered) {
        this.recordRecent('desktop', task.id, task.title, now)
        this.deps.store.recordReminder(task.id, 'delivered', now)
        changed = true
      }
    }
    this.announcements = this.announcements.filter((a) => a.expiresAt > now).slice(-1000)
    this.deps.store.pruneAnnouncements(now)
    if (changed) this.emit()
  }
  claimAnnouncement(device: string): { id: string; text: string } | null {
    device = text(device, 64, true)
    if (!this.settings.voiceOutput || this.quiet(this.now())) return null
    const now = this.now(),
      item = this.announcements.find(
        (a) => a.expiresAt > now && !a.acked.has(device) && (a.leases.get(device) ?? 0) <= now,
      )
    if (!item) return null
    if (item.leases.size >= 16 && !item.leases.has(device)) throw new Error('语音设备数量已达上限')
    item.leases.set(device, now + 60000)
    return { id: item.id, text: item.text }
  }
  acknowledgeAnnouncement(device: string, id: string): void {
    const item = this.announcements.find((a) => a.id === id)
    if (!item || !item.leases.has(device)) throw new Error('播报记录已过期')
    if (!item.acked.has(device)) this.recordRecent(device, item.taskId, item.text, this.now())
    this.deps.store.ackAnnouncement(item.id, device)
    item.acked.add(device)
    this.deps.store.recordReminder(item.taskId, 'delivered', this.now())
    this.emit()
  }
  showOnInk(): AssistantSnapshot {
    this.inkUntil = this.now() + 900000
    this.emit()
    return this.snapshot()
  }
  clearTemporaryInk(): void {
    if (this.inkUntil) {
      this.inkUntil = 0
      this.emit()
    }
  }
  hideOnInk(): AssistantSnapshot {
    this.inkUntil = 0
    this.deps.restoreWork?.()
    this.emit()
    return this.snapshot()
  }
  inkCard(
    status: Pick<StatusSnapshot, 'agents'>,
    preview = false,
  ): (AmbientCard & { manual?: true }) | undefined {
    if (
      !preview &&
      ((!this.deps.automaticAllowed?.() && this.inkUntil <= this.now()) ||
        status.agents.some(
          (a) =>
            !a.taskHidden &&
            (['action', 'fault'].includes(hudStateLevel(a)) ||
              (this.inkUntil <= this.now() && hudStateLevel(a) === 'notice')),
        ))
    )
      return undefined
    const all = this.deps.store.list().filter((t) => t.status === 'pending'),
      tasks = all.slice(0, 6)
    const items = tasks.map((t) => ({
      title: t.title,
      meta: t.dueAt
        ? new Date(t.dueAt).toLocaleString('zh-CN', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          })
        : '未设提醒',
      overdue: t.dueAt !== null && t.dueAt <= this.now(),
    }))
    const body = tasks.length
      ? tasks
          .map(
            (t, i) =>
              `${i + 1}. ${t.title}${t.dueAt ? ` · ${new Date(t.dueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}` : ''}`,
          )
          .join('   ')
      : '今天的待办已完成。留一点时间给自己。'
    const hash = createHash('sha256')
      .update(JSON.stringify({ items, total: all.length }))
      .digest('hex')
      .slice(0, 16)
    return {
      id: 'todos-' + hash,
      kind: 'note',
      source: `待办与提醒 · ${all.length} 项`,
      text: body,
      items,
      url: '',
      publishedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
      score: 0,
      ...(preview || this.inkUntil > this.now() ? { manual: true as const } : {}),
    }
  }
  private quiet(now: number): boolean {
    const h = new Date(now).getHours(),
      s = this.settings
    return (
      s.quietStart !== s.quietEnd &&
      (s.quietStart < s.quietEnd
        ? h >= s.quietStart && h < s.quietEnd
        : h >= s.quietStart || h < s.quietEnd)
    )
  }
  private clearAnnouncements(): void {
    this.announcements = []
  }
  private recordRecent(device: string, taskId: string, title: string, at: number): void {
    if (this.recentReminders.size >= 32 && !this.recentReminders.has(device))
      this.recentReminders.delete(this.recentReminders.keys().next().value!)
    this.recentReminders.set(device, { taskId, title, at })
  }
  private removeAnnouncements(taskId: string): void {
    this.deps.store.removeTaskAnnouncements(taskId)
    this.announcements = this.announcements.filter((a) => a.taskId !== taskId)
  }
  private emit(): void {
    this.deps.changed()
  }
}
export function normalizeAssistantSettings(input: unknown): AssistantSettings {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const s = { ...DEFAULT_ASSISTANT_SETTINGS, ...raw }
  if (
    !['general_assistant', 'teacher_work', 'family_reading'].includes(s.scene as string) ||
    !['tongyi', 'glm'].includes(s.provider as string) ||
    typeof s.model !== 'string' ||
    !/^[-a-zA-Z0-9._]{1,80}$/.test(s.model) ||
    typeof s.voice !== 'string' ||
    !/^[-a-zA-Z0-9_]{1,50}$/.test(s.voice)
  )
    throw new Error('助手设置无效')
  for (const field of ['voiceInput', 'voiceOutput', 'notifications'])
    if (typeof s[field as keyof typeof s] !== 'boolean') throw new Error('助手开关设置无效')
  for (const field of ['quietStart', 'quietEnd']) {
    const v = s[field as keyof typeof s]
    if (!Number.isInteger(v) || Number(v) < 0 || Number(v) > 23) throw new Error('安静时段设置无效')
  }
  return {
    version: 1,
    scene: s.scene,
    provider: s.provider,
    model: s.model,
    voice: s.voice,
    voiceInput: s.voiceInput,
    voiceOutput: s.voiceOutput,
    quietStart: s.quietStart,
    quietEnd: s.quietEnd,
    notifications: s.notifications,
  } as AssistantSettings
}
export function publicAssistantError(error: unknown): string {
  // Only our own short Chinese validation errors cross IPC; never forward provider bodies/URLs/headers.
  const value = error instanceof Error ? error.message : ''
  return /^[\u3400-\u9fff]/.test(value) && value.length <= 160
    ? value
    : '助手暂时无法连接，请检查配置和网络后重试'
}

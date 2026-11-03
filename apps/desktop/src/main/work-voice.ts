import {
  TurnState,
  workspaceKey,
  type AgentRuntimeState,
  type StatusSnapshot,
  type UiLocale,
  type WorkVoiceSettings,
  type WorkVoiceSnapshot,
} from '@codepulse/shared'

type Kind = 'permission' | 'input' | 'error' | 'timeout' | 'limited'
interface Candidate {
  kind: Kind
  at: number
}
interface Dependencies {
  supported: boolean
  speak(text: string, locale: UiLocale, valid: () => boolean): Promise<void>
  cancel(): void
  changed?(value: WorkVoiceSnapshot): void
  now?(): number
  schedule?(callback: () => void, ms: number): () => void
}

/** Observe canonical tasks without changing read state, notification rules or device refresh. */
export class WorkVoice {
  private primed = false
  private seen = new Set<string>()
  private current = new Map<string, Kind>()
  private waitingEpisodes = new Map<string, { epoch: number; waiting: boolean }>()
  private pending = new Map<string, Candidate>()
  private cancelTimer?: () => void
  private speaking = false
  private error: WorkVoiceSnapshot['error'] = null
  private lastSpokeAt = -Infinity
  private generation = 0
  private stopped = false
  private readonly startedAt: number
  private locale: UiLocale = 'zh'

  constructor(
    private settings: WorkVoiceSettings,
    private deps: Dependencies,
  ) {
    this.settings = { ...settings }
    this.startedAt = this.now()
  }

  snapshot(): WorkVoiceSnapshot {
    return {
      settings: { ...this.settings },
      supported: this.deps.supported,
      speaking: this.speaking,
      error: this.error,
    }
  }

  setLocale(locale: UiLocale): void {
    this.locale = locale
  }

  configure(settings: WorkVoiceSettings): WorkVoiceSnapshot {
    this.stopSpeaking()
    this.settings = { ...settings }
    this.error = null
    this.emit()
    return this.snapshot()
  }

  observe(snapshot: StatusSnapshot): void {
    if (this.stopped) return
    const now = this.now()
    const current = new Map<string, Kind>()
    for (const agent of snapshot.agents) {
      if (agent.taskHidden) continue
      const identity = [
        agent.agentType,
        workspaceKey(agent.workspacePath),
        agent.externalSessionId ?? '',
        agent.externalTurnId ?? agent.turnStartedAt ?? '',
      ]
      const scope = JSON.stringify(identity)
      const episode = this.waitingEpisodes.get(scope) ?? { epoch: 0, waiting: false }
      if (
        episode.waiting &&
        (agent.state === TurnState.PROMPT_SUBMITTED ||
          agent.state === TurnState.THINKING ||
          agent.state === TurnState.TOOL_RUNNING)
      ) {
        episode.epoch++
        episode.waiting = false
      }
      const kind = voiceKind(agent)
      if (kind === 'permission' || kind === 'input') episode.waiting = true
      this.waitingEpisodes.set(scope, episode)
      if (!kind) continue
      // Different waiting episodes cannot resurrect a previously cancelled device clip.
      const key = JSON.stringify([
        ...identity,
        kind,
        kind === 'permission' || kind === 'input' ? episode.epoch : 0,
      ])
      current.set(key, kind)
      if (this.seen.has(key) || this.current.has(key)) continue
      this.seen.add(key)
      // Initial/native history and enabling speech must never read old tasks aloud.
      if (
        this.primed &&
        now >= this.startedAt + 10_000 &&
        (agent.terminalAt ?? agent.lastEventAt) > this.startedAt &&
        this.allowed(kind)
      ) {
        this.pending.set(key, { kind, at: now })
      }
    }
    this.primed = true
    this.current = current
    for (const key of this.pending.keys()) if (!current.has(key)) this.pending.delete(key)
    while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value!)
    while (this.waitingEpisodes.size > 2048)
      this.waitingEpisodes.delete(this.waitingEpisodes.keys().next().value!)
    this.schedule()
  }

  async test(locale: UiLocale): Promise<WorkVoiceSnapshot> {
    if (this.stopped || this.speaking) return this.snapshot()
    this.setLocale(locale)
    await this.play(
      locale === 'zh'
        ? 'CodePulse 语音提醒已准备好，需要你操作时，我会在这里提醒你。'
        : 'CodePulse voice is ready. I can let you know when a task needs your attention.',
    )
    return this.snapshot()
  }

  stopSpeaking(): void {
    this.generation++
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.pending.clear()
    this.deps.cancel()
    this.speaking = false
    this.emit()
  }

  close(): void {
    this.stopped = true
    this.stopSpeaking()
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private allowed(kind: Kind): boolean {
    return (
      !this.stopped &&
      this.settings.enabled &&
      this.deps.supported &&
      (kind === 'permission' || kind === 'input'
        ? this.settings.intervention
        : this.settings.failures)
    )
  }

  private schedule(): void {
    if (this.stopped || this.speaking || this.cancelTimer || !this.pending.size) return
    const earliest = Math.min(...[...this.pending.values()].map((value) => value.at + 2000))
    const delay = Math.max(0, earliest - this.now(), this.lastSpokeAt + 60_000 - this.now())
    const run = () => {
      this.cancelTimer = undefined
      void this.flush()
    }
    if (this.deps.schedule) this.cancelTimer = this.deps.schedule(run, delay)
    else {
      const timer = setTimeout(run, delay)
      timer.unref?.()
      this.cancelTimer = () => clearTimeout(timer)
    }
  }

  private async flush(): Promise<void> {
    if (this.speaking) return
    const candidates: [string, Candidate][] = []
    for (const [key, value] of this.pending) {
      if (!this.current.has(key) || !this.allowed(value.kind) || this.now() - value.at >= 120_000) {
        this.pending.delete(key)
      } else if (this.now() - value.at >= 2000) {
        candidates.push([key, value])
        this.pending.delete(key)
      }
    }
    if (!candidates.length) {
      this.schedule()
      return
    }
    await this.play(
      workVoiceMessage(
        candidates.map(([, value]) => value.kind),
        this.locale,
      ),
      () =>
        candidates.some(
          ([key, value]) =>
            this.current.has(key) && this.allowed(value.kind) && this.now() - value.at < 120_000,
        ),
    )
  }

  private async play(text: string, valid?: () => boolean): Promise<void> {
    if (!this.deps.supported) {
      this.error = 'unavailable'
      this.emit()
      return
    }
    const generation = ++this.generation
    this.speaking = true
    this.error = null
    this.lastSpokeAt = this.now()
    this.emit()
    try {
      const expiresAt = this.now() + 120_000
      await this.deps.speak(
        text,
        this.locale,
        valid ?? (() => !this.stopped && this.now() < expiresAt),
      )
    } catch {
      if (generation === this.generation) this.error = 'failed'
    } finally {
      if (generation === this.generation) {
        this.speaking = false
        this.emit()
        this.schedule()
      }
    }
  }

  private emit(): void {
    this.deps.changed?.(this.snapshot())
  }
}

function voiceKind(agent: AgentRuntimeState): Kind | undefined {
  switch (agent.state) {
    case TurnState.WAITING_PERMISSION:
      return 'permission'
    case TurnState.WAITING_USER_INPUT:
      return 'input'
    case TurnState.ERROR:
      return agent.unread ? 'error' : undefined
    case TurnState.TIMEOUT:
      return agent.unread ? 'timeout' : undefined
    case TurnState.USAGE_LIMITED:
      return agent.unread ? 'limited' : undefined
    default:
      return undefined
  }
}

/** Fixed phrases only: never speak project paths, prompts, commands or model output. */
export function workVoiceMessage(kinds: Kind[], locale: UiLocale): string {
  if (kinds.length > 1)
    return locale === 'zh'
      ? `CodePulse，有 ${kinds.length} 个任务需要你处理，请查看控制台。`
      : `CodePulse. ${kinds.length} tasks need your attention. Please check the console.`
  const messages: Record<Kind, [string, string]> = {
    permission: [
      '有任务等待你授权，请查看控制台。',
      'A task needs your approval. Please check the console.',
    ],
    input: [
      '有任务等待你补充信息，请查看控制台。',
      'A task needs your input. Please check the console.',
    ],
    error: ['有任务执行失败，请查看控制台。', 'A task failed. Please check the console.'],
    timeout: [
      '有任务长时间没有进展，请查看控制台。',
      'A task may be stuck. Please check the console.',
    ],
    limited: [
      '有任务因额度受限暂停，请查看控制台。',
      'A task has reached its usage limit. Please check the console.',
    ],
  }
  return 'CodePulse，' + messages[kinds[0] ?? 'input'][locale === 'zh' ? 0 : 1]
}

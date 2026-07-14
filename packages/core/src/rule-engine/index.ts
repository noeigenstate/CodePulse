import {
  type AgentRuntimeState,
  type NotificationLevel,
  type NotificationRequest,
  TurnState,
  workspaceKey,
} from '@codepulse/shared'
import type { TransitionResult } from '../state-machine/index.js'

export const STUCK_SOFT_MS = 2 * 60_000
export const STUCK_VISIBLE_MS = 5 * 60_000
export const STUCK_STRONG_MS = 10 * 60_000

export interface RuleEngineOptions {
  muted?: boolean
  sessionThrottleMs?: number
  permissionThrottleMs?: number
}

const DEFAULTS = {
  sessionThrottleMs: 30_000,
}

const FIRED_KEY_RETENTION_MS = 10 * 60_000

/**
 * Turns runtime transitions into user notifications.
 *
 * The product notification policy is intentionally narrow: only completed turns
 * should reach the OS/toast layer. Context, quota, permission, error, cancel and
 * stuck states remain visible in the dashboard state, but they do not create
 * pop-up notifications.
 */
export class RuleEngine {
  private lastFiredAt = new Map<string, number>()

  constructor(private options: RuleEngineOptions = {}) {}

  setMuted(muted: boolean): void {
    this.options.muted = muted
  }

  onTransition(result: TransitionResult, now = Date.now()): NotificationRequest[] {
    const { next, previous, previousState } = result
    if (next.state === previousState || next.state !== TurnState.DONE) return []

    const out: NotificationRequest[] = []
    const scope = agentScope(next)
    const project = projectLabel(next.workspacePath)
    this.push(out, now, {
      level: 'normal',
      // Lead with the project name — users care which repo finished, not "Codex 一轮任务".
      title: `${completionEmoji(project)} ${project} 已完成`,
      body: completionBody(project, next.agentType),
      dedupeKey: `done:${scope}:${
        next.externalTurnId ?? previous.externalTurnId ?? previous.turnStartedAt ?? now
      }`,
    })
    return out
  }

  onTick(_agent: AgentRuntimeState, _now = Date.now()): NotificationRequest[] {
    return []
  }

  private push(
    out: NotificationRequest[],
    now: number,
    spec: {
      level: NotificationLevel
      title: string
      body: string
      dedupeKey: string
      throttleMs?: number
    },
  ): void {
    this.pruneFiredKeys(now)
    const throttle = spec.throttleMs ?? this.options.sessionThrottleMs ?? DEFAULTS.sessionThrottleMs
    const last = this.lastFiredAt.get(spec.dedupeKey)
    if (last != null && now - last < throttle) return
    this.lastFiredAt.set(spec.dedupeKey, now)
    out.push({
      level: spec.level,
      title: spec.title,
      body: spec.body,
      dedupeKey: spec.dedupeKey,
      sound: !this.options.muted && spec.level !== 'soft',
      createdAt: now,
    })
  }

  private pruneFiredKeys(now: number): void {
    for (const [key, firedAt] of this.lastFiredAt) {
      if (now - firedAt > FIRED_KEY_RETENTION_MS) this.lastFiredAt.delete(key)
    }
  }
}

function agentLabel(agent: string): string {
  if (agent === 'codex') return 'Codex'
  if (agent === 'grok') return 'Grok'
  return 'Claude Code'
}

function agentScope(agent: AgentRuntimeState): string {
  return `${agent.agentType}:${workspaceKey(agent.workspacePath)}`
}

function projectLabel(workspacePath: string | undefined): string {
  if (!workspacePath) return '未知项目'
  const parts = workspacePath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.at(-1) ?? '未知项目'
}

const COMPLETION_EMOJIS = ['💖', '💕', '✨', '🎉', '🌸', '🍀', '💝', '⭐'] as const
const COMPLETION_BODIES = [
  '可以去看看啦 ✨',
  '这一波收工啦 💕',
  '成果新鲜出炉 🎉',
  '去瞅一眼吧 💖',
  '漂亮收工 🌸',
] as const

/** Stable cute emoji so the same project doesn't jump styles every toast. */
function completionEmoji(project: string): string {
  return COMPLETION_EMOJIS[hashText(project) % COMPLETION_EMOJIS.length]!
}

function completionBody(project: string, agentType: string): string {
  const cute = COMPLETION_BODIES[hashText(`${project}:${agentType}`) % COMPLETION_BODIES.length]!
  // Keep agent as a quiet hint at the end — project remains the focus.
  return `${cute} · ${agentLabel(agentType)}`
}

function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

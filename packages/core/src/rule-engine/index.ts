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
    const promptSummary = summarizeUserPrompt(next.lastUserPrompt ?? previous.lastUserPrompt, 8)
    this.push(out, now, {
      level: 'normal',
      // Project name is primary; no Claude/Codex branding in the toast.
      title: `${completionEmoji(project)} ${project} 已完成`,
      // Body is a short summary of the user question (≤8 chars), not agent name.
      body: promptSummary,
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

/** Stable cute emoji so the same project doesn't jump styles every toast. */
function completionEmoji(project: string): string {
  return COMPLETION_EMOJIS[hashText(project) % COMPLETION_EMOJIS.length]!
}

/**
 * Compact the user prompt into a short toast summary (default ≤8 graphemes).
 * Not an LLM summary — strip noise and truncate for glanceable notifications.
 */
export function summarizeUserPrompt(prompt: string | undefined, maxChars = 8): string {
  if (!prompt) return '任务完成'
  let text = prompt
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()

  // Drop common chat wrappers / filler so the first content words fit in 8 chars.
  text = text
    .replace(/^<user_query>\s*/i, '')
    .replace(/<\/user_query>[\s\S]*$/i, '')
    .replace(/^(请你?|麻烦你?|帮我|帮忙|能否|可以|能不能|烦请)+/u, '')
    .replace(/[。！？!?,，、.…]+$/u, '')
    .trim()

  if (!text) return '任务完成'
  return truncateGraphemes(text, maxChars)
}

function truncateGraphemes(text: string, maxChars: number): string {
  const chars = [...text]
  if (chars.length <= maxChars) return chars.join('')
  return chars.slice(0, maxChars).join('')
}

function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

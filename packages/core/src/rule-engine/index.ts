import {
  type AgentRuntimeState,
  type NotificationLevel,
  type NotificationRequest,
  type UiLocale,
  TurnState,
  isActiveState,
  workspaceKey,
} from '@codepulse/shared'
import type { TransitionResult } from '../state-machine/index.js'

export const STUCK_SOFT_MS = 2 * 60_000
export const STUCK_VISIBLE_MS = 5 * 60_000
export const STUCK_STRONG_MS = 10 * 60_000

export interface RuleEngineOptions {
  muted?: boolean
  locale?: UiLocale
  sessionThrottleMs?: number
  permissionThrottleMs?: number
}

/** Bounds once-per-turn notification history without time-based re-firing. */
const MAX_FIRED_KEYS = 2_048

/**
 * Turns runtime transitions into user notifications.
 *
 * The product notification policy is intentionally narrow: only a confirmed
 * active-to-completed transition or the watchdog's active-to-timeout transition
 * reaches the OS/toast layer. Context, quota, permission, error, cancel, and
 * usage-limit states remain visible without pop-up notifications.
 */
export class RuleEngine {
  private lastFiredAt = new Map<string, number>()

  constructor(private options: RuleEngineOptions = {}) {}

  setMuted(muted: boolean): void {
    this.options.muted = muted
  }

  setLocale(locale: UiLocale): void {
    this.options.locale = locale
  }

  onTransition(result: TransitionResult, now = Date.now()): NotificationRequest[] {
    const { next, previous, previousState } = result
    if (next.state === previousState || !isActiveState(previousState)) return []

    const out: NotificationRequest[] = []
    const scope = agentScope(next)
    const locale = this.options.locale ?? 'zh'
    const project = projectLabel(next.workspacePath, locale)
    const turn = next.externalTurnId ?? previous.externalTurnId ?? previous.turnStartedAt ?? now

    if (next.state === TurnState.TIMEOUT) {
      this.push(out, now, {
        level: 'strong',
        title: locale === 'zh' ? `⚠️ ${project} 疑似卡住` : `⚠️ ${project} may be stuck`,
        body:
          locale === 'zh'
            ? '长时间没有新活动，请打开 CodePulse 检查'
            : 'No activity for a while. Open CodePulse to check.',
        dedupeKey: `stuck:${scope}:${turn}`,
      })
      return out
    }

    if (next.state !== TurnState.DONE) return []
    const promptSummary = completionNotificationBody(
      next.lastUserPrompt ?? previous.lastUserPrompt,
      locale,
      15,
    )
    this.push(out, now, {
      level: 'normal',
      // Project name is primary; no Claude/Codex branding in the toast.
      title:
        locale === 'zh'
          ? `${completionEmoji(project)} ${project} 已完成`
          : `${completionEmoji(project)} ${project} completed`,
      // Body is a short word-capped summary of the user question, not agent name.
      body: promptSummary,
      dedupeKey: `done:${scope}:${turn}`,
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
    },
  ): void {
    if (this.lastFiredAt.has(spec.dedupeKey)) return
    this.lastFiredAt.set(spec.dedupeKey, now)
    this.pruneFiredKeys()
    out.push({
      level: spec.level,
      title: spec.title,
      body: spec.body,
      dedupeKey: spec.dedupeKey,
      sound: !this.options.muted && spec.level !== 'soft',
      createdAt: now,
    })
  }

  /** Removes the oldest once-per-turn keys after the fixed memory bound. */
  private pruneFiredKeys(): void {
    while (this.lastFiredAt.size > MAX_FIRED_KEYS) {
      const oldest = this.lastFiredAt.keys().next().value as string | undefined
      if (!oldest) return
      this.lastFiredAt.delete(oldest)
    }
  }
}

function agentScope(agent: AgentRuntimeState): string {
  return `${agent.agentType}:${workspaceKey(agent.workspacePath)}`
}

function projectLabel(workspacePath: string | undefined, locale: UiLocale): string {
  const fallback = locale === 'zh' ? '未知项目' : 'Unknown project'
  if (!workspacePath) return fallback
  const parts = workspacePath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  return parts.at(-1) ?? fallback
}

const COMPLETION_EMOJIS = ['💖', '💕', '✨', '🎉', '🌸', '🍀', '💝', '⭐'] as const

/** Stable cute emoji so the same project doesn't jump styles every toast. */
function completionEmoji(project: string): string {
  return COMPLETION_EMOJIS[hashText(project) % COMPLETION_EMOJIS.length]!
}

/**
 * Build a glanceable toast summary of the user prompt.
 *
 * Limit:
 * - Chinese-heavy text: ≤15 汉字 (Han characters)
 * - English-heavy text: ≤15 words
 *
 * Heuristic "summary" (not an LLM paraphrase):
 * 1. strip wrappers, code, URLs and polite filler
 * 2. keep the primary ask clause
 * 3. cap so the OS toast second line can show a complete short line
 */
export function summarizeUserPrompt(prompt: string | undefined, maxUnits = 15): string {
  if (!prompt) return '任务完成'

  let text = prompt
    // Drop fenced code / tags that drown the intent.
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<user_query>\s*/gi, ' ')
    .replace(/<\/user_query>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/gi, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
    .trim()

  // Prefer the first sentence so multi-paragraph dumps collapse to one ask.
  text = firstClause(text)

  // Drop polite / chat filler so the remaining words are the ask itself.
  text = stripLeadingFiller(text)
    .replace(/[。！？!?,，、.…；;]+$/u, '')
    .trim()

  if (!text) return '任务完成'

  if (isPrimarilyCjk(text)) {
    return clipChineseSummary(text, maxUnits) || '任务完成'
  }

  const words = tokenizeWords(text)
  if (words.length === 0) return '任务完成'
  // Complete word units only — never cut mid-word for English.
  return joinWords(words.slice(0, maxUnits)) || '任务完成'
}

/**
 * Make the completion toast follow the selected UI language. This deliberately
 * avoids pretending to translate arbitrary prompts: a prompt written in the
 * other language gets a stable localized completion message instead.
 */
export function completionNotificationBody(
  prompt: string | undefined,
  locale: UiLocale,
  maxUnits = 15,
): string {
  const summary = summarizeUserPrompt(prompt, maxUnits)
  if (locale === 'zh') {
    return isPrimarilyCjk(summary) ? summary : '任务已完成，请打开应用查看详情'
  }
  return isPrimarilyCjk(summary) ? 'Task completed. Open CodePulse for details.' : summary
}

/** Prefer the Han-character budget when CJK dominates the cleaned prompt. */
export function isPrimarilyCjk(text: string): boolean {
  const chars = [...text]
  let cjk = 0
  let latin = 0
  for (const ch of chars) {
    if (isCjk(ch)) cjk += 1
    else if (/[A-Za-z]/u.test(ch)) latin += 1
  }
  if (cjk === 0) return false
  // Pure / mostly Chinese prompts use the 汉字 limit.
  return cjk >= latin
}

/**
 * Cap Chinese summaries by 汉字 count (default 15), not by 2-char "words".
 * Embedded Latin tokens still appear but each word consumes 1 unit of the budget.
 */
export function clipChineseSummary(text: string, maxHan = 15): string {
  const chars = [...text]
  let units = 0
  let out = ''
  let i = 0

  while (i < chars.length && units < maxHan) {
    const ch = chars[i]!

    if (/\s/u.test(ch)) {
      if (out && !/\s$/u.test(out)) out += ' '
      i += 1
      continue
    }

    if (/[A-Za-z0-9]/u.test(ch)) {
      let j = i + 1
      while (j < chars.length && /[A-Za-z0-9''’.]/u.test(chars[j]!)) j += 1
      if (units >= maxHan) break
      out += chars.slice(i, j).join('')
      units += 1
      i = j
      continue
    }

    if (isCjk(ch)) {
      out += ch
      units += 1
      i += 1
      continue
    }

    // Keep light punctuation between tokens when budget remains.
    out += ch
    i += 1
  }

  return out.replace(/\s+/g, ' ').trim()
}

function firstClause(text: string): string {
  const match = text.match(/^(.+?)(?:[。！？!?](?=\s|$)|[；;](?=\s)|[|]{2})/u)
  const clause = match?.[1]?.trim()
  return clause && clause.length >= 2 ? clause : text
}

function stripLeadingFiller(text: string): string {
  let current = text
  // Repeat a few times for stacked openers like "Please help me 请帮我..."
  for (let i = 0; i < 3; i++) {
    const next = current
      .replace(
        /^(please\s+)?(can you|could you|would you|help me|help us|i need you to|i want you to|i'd like you to)\s+/i,
        '',
      )
      .replace(/^(please|pls|plz)\s+/i, '')
      .replace(
        /^(请你?|麻烦你?|烦请|拜托|帮我|帮忙|帮忙把|请帮我|请帮忙|能否|可以|能不能|麻烦)+/u,
        '',
      )
      .replace(/^(把|将|为|给我|帮|去)\s*/u, '')
      .trim()
    if (next === current) break
    current = next
  }
  return current
}

/**
 * Mixed EN/CJK tokenizer for toast length control.
 * - Latin / numbers: whitespace-style words
 * - CJK: ~2-char words, with common single-char particles kept separate
 */
export function tokenizeWords(text: string): string[] {
  const tokens: string[] = []
  const chars = [...text]
  let i = 0

  while (i < chars.length) {
    const ch = chars[i]!
    if (/\s/u.test(ch)) {
      i += 1
      continue
    }

    if (/[A-Za-z]/u.test(ch)) {
      let j = i + 1
      while (j < chars.length && /[A-Za-z''’]/u.test(chars[j]!)) j += 1
      tokens.push(chars.slice(i, j).join(''))
      i = j
      continue
    }

    if (/\d/u.test(ch)) {
      let j = i + 1
      while (j < chars.length && /[\d.]/u.test(chars[j]!)) j += 1
      tokens.push(chars.slice(i, j).join(''))
      i = j
      continue
    }

    if (isCjk(ch)) {
      if (isCjkParticle(ch)) {
        tokens.push(ch)
        i += 1
        continue
      }
      const next = chars[i + 1]
      if (next && isCjk(next) && !isCjkParticle(next)) {
        tokens.push(ch + next)
        i += 2
        continue
      }
      tokens.push(ch)
      i += 1
      continue
    }

    // Skip punctuation / symbols between words.
    i += 1
  }

  return tokens
}

function joinWords(words: string[]): string {
  let out = ''
  for (const word of words) {
    if (!out) {
      out = word
      continue
    }
    // Space only between Latin/numeric tokens; CJK joins tightly.
    if (/[A-Za-z0-9]$/u.test(out) && /^[A-Za-z0-9]/u.test(word)) {
      out += ` ${word}`
    } else {
      out += word
    }
  }
  return out
}

function isCjk(ch: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(ch)
}

function isCjkParticle(ch: string): boolean {
  return '的了吗呢吧啊嘛呀么与及并和且把将被在从对为向'.includes(ch)
}

function hashText(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) >>> 0
  }
  return hash
}

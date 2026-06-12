import { open } from 'node:fs/promises'
import {
  type AgentEvent,
  type TokenPayload,
  parseTokenCount,
  workspaceKey,
} from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'

const TAIL_BYTES = 1024 * 1024
const DEFAULT_CODEX_CONTEXT_WINDOW = 256_000
const DEFAULT_SCHEDULE_OFFSETS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const
const MAX_TIMEOUT_MS = 2_147_483_647

interface BoundQuotaSource {
  sourcePath: string
  source: 'codex'
  externalSessionId?: string
  externalTurnId?: string
  workspacePath?: string
  cwd?: string
  model?: string
}

export interface QuotaRefreshWatcherOptions {
  hub: StatusHub
  now?: () => number
  scheduleOffsetsMs?: readonly number[]
  readToken?: (sourcePath: string) => Promise<TokenPayload | undefined>
}

export class QuotaRefreshWatcher {
  private readonly hub: StatusHub
  private readonly now: () => number
  private readonly scheduleOffsetsMs: readonly number[]
  private readonly readToken: (sourcePath: string) => Promise<TokenPayload | undefined>
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(options: QuotaRefreshWatcherOptions) {
    this.hub = options.hub
    this.now = options.now ?? Date.now
    this.scheduleOffsetsMs = options.scheduleOffsetsMs ?? DEFAULT_SCHEDULE_OFFSETS_MS
    this.readToken = options.readToken ?? readCodexQuotaTokenFromFile
  }

  observe(event: AgentEvent): void {
    if (event.source !== 'codex' || !event.tokenSourcePath || !event.token?.rateLimits) return

    const binding: BoundQuotaSource = {
      source: 'codex',
      sourcePath: event.tokenSourcePath,
      externalSessionId: event.externalSessionId,
      externalTurnId: event.externalTurnId,
      workspacePath: event.workspacePath,
      cwd: event.cwd,
      model: event.model,
    }

    for (const resetAt of resetTimes(event.token)) {
      this.schedule(binding, resetAt)
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private schedule(binding: BoundQuotaSource, resetAt: number): void {
    for (const offset of this.scheduleOffsetsMs) {
      const runAt = normalizeResetAt(resetAt) + offset
      const delay = runAt - this.now()
      if (delay < 0 || delay > MAX_TIMEOUT_MS) continue

      if (delay === 0) {
        void this.refresh(binding)
        continue
      }

      const key = `${binding.source}\0${binding.sourcePath}\0${resetAt}\0${offset}`
      if (this.timers.has(key)) continue

      const timer = setTimeout(() => {
        this.timers.delete(key)
        void this.refresh(binding)
      }, delay)
      timer.unref?.()
      this.timers.set(key, timer)
    }
  }

  private async refresh(binding: BoundQuotaSource): Promise<void> {
    const token = await this.readToken(binding.sourcePath)
    if (!token?.rateLimits) return

    this.hub.ingest({
      id: `quota-refresh:${binding.source}:${workspaceKey(binding.workspacePath ?? binding.cwd)}:${this.now()}`,
      source: binding.source,
      eventType: 'token_snapshot',
      externalSessionId: binding.externalSessionId,
      externalTurnId: binding.externalTurnId,
      workspacePath: binding.workspacePath,
      cwd: binding.cwd,
      model: binding.model,
      token,
      tokenSourcePath: binding.sourcePath,
      timestamp: this.now(),
    })
  }
}

export async function readCodexQuotaTokenFromFile(
  sourcePath: string,
): Promise<TokenPayload | undefined> {
  const lines = (await readTail(sourcePath)).trim().split(/\r?\n/)
  let tokenCount: Record<string, unknown> | undefined
  let taskStarted: Record<string, unknown> | undefined

  for (let i = lines.length - 1; i >= 0; i--) {
    let item: unknown
    try {
      item = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (!isRecord(item) || item.type !== 'event_msg') continue
    const payload = isRecord(item.payload) ? item.payload : undefined
    if (!tokenCount && payload?.type === 'token_count') tokenCount = payload
    if (!taskStarted && payload?.type === 'task_started') taskStarted = payload
    if (tokenCount && taskStarted) break
  }

  return tokenCount ? toCodexToken(tokenCount, taskStarted) : undefined
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function toCodexToken(
  tokenCount: Record<string, unknown>,
  taskStarted: Record<string, unknown> | undefined,
): TokenPayload | undefined {
  const info = isRecord(tokenCount.info) ? tokenCount.info : {}
  const usage = readUsage(info.total_token_usage) ?? readUsage(info.last_token_usage)
  const contextUsage = readUsage(info.last_token_usage) ?? usage
  const rawRateLimits = tokenCount.rate_limits ?? info.rate_limits
  const rateLimits = normalizeRateLimits(rawRateLimits)
  const rateLimitId = readRateLimitString(rawRateLimits, 'limit_id', 'limitId')
  const rateLimitName = readRateLimitString(rawRateLimits, 'limit_name', 'limitName')
  const contextWindow =
    optionalNumber(info.model_context_window) ??
    optionalNumber(taskStarted?.model_context_window) ??
    DEFAULT_CODEX_CONTEXT_WINDOW
  const contextInput =
    optionalNumber(contextUsage?.input_tokens) ?? optionalNumber(contextUsage?.cached_input_tokens)
  const contextUsedPercent =
    contextWindow && contextInput ? Math.min(100, (contextInput / contextWindow) * 100) : undefined

  if (!usage && !contextUsage && !rateLimits && contextUsedPercent === undefined) return undefined

  return {
    input: optionalNumber(usage?.input_tokens),
    cachedInput: optionalNumber(usage?.cached_input_tokens),
    output: optionalNumber(usage?.output_tokens),
    reasoningOutput: optionalNumber(usage?.reasoning_output_tokens),
    total: optionalNumber(usage?.total_tokens),
    contextUsedPercent,
    contextWindow,
    rateLimits,
    rateLimitId,
    rateLimitName,
    accuracy: 'estimated',
  }
}

function readUsage(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function normalizeRateLimits(value: unknown): TokenPayload['rateLimits'] {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  const fiveHour = normalizeWindow(raw.five_hour ?? raw.fiveHour ?? raw.primary)
  const sevenDay = normalizeWindow(raw.seven_day ?? raw.sevenDay ?? raw.secondary)
  if (!fiveHour && !sevenDay) return undefined
  return { fiveHour, sevenDay }
}

function normalizeWindow(value: unknown): NonNullable<TokenPayload['rateLimits']>['fiveHour'] {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  const usedPercent = optionalNumber(raw.used_percentage ?? raw.usedPercent ?? raw.used_percent)
  const resetsAt = optionalNumber(raw.resets_at ?? raw.resetsAt)
  const windowMinutes = optionalNumber(raw.window_minutes ?? raw.windowMinutes)
  if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
    return undefined
  }
  return { usedPercent, resetsAt, windowMinutes }
}

function readRateLimitString(value: unknown, ...keys: string[]): string | undefined {
  const raw = isRecord(value) ? value : undefined
  if (!raw) return undefined
  for (const key of keys) {
    const item = raw[key]
    if (typeof item === 'string' && item.length > 0) return item
  }
  return undefined
}

function resetTimes(token: TokenPayload): number[] {
  return [token.rateLimits?.fiveHour?.resetsAt, token.rateLimits?.sevenDay?.resetsAt].filter(
    (value): value is number => value !== undefined && Number.isFinite(value),
  )
}

function normalizeResetAt(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function optionalNumber(value: unknown): number | undefined {
  return parseTokenCount(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

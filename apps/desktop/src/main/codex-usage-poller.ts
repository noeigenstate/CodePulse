/**
 * Codex `/status` usage poller.
 *
 * Codex writes token_count records, including rate limits, into local rollout
 * JSONL files. Slash commands do not necessarily trigger lifecycle hooks, so
 * the desktop app polls the newest rollout and feeds a token_snapshot into the
 * hub. The reader extracts only metadata and token counters.
 *
 * @module main/codex-usage-poller
 */
import { readdir, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { normalizeEvent, type StatusHub } from '@codepulse/core'
import { parseTokenCount, type AgentEventInput, type TokenPayload } from '@codepulse/shared'

const TAIL_BYTES = 1024 * 1024
const HEAD_BYTES = 64 * 1024
const MAX_ROLLOUT_FILES = 300
const MAX_CODEX_SNAPSHOTS = 20
const DEFAULT_CODEX_CONTEXT_WINDOW =
  parseTokenCount(process.env.CODEPULSE_CODEX_CONTEXT_WINDOW) ?? 256_000
export const CODEX_USAGE_POLL_INTERVAL_MS =
  Number(process.env.CODEPULSE_CODEX_USAGE_POLL_MS) || 5_000

interface RolloutFile {
  path: string
  mtimeMs: number
}

interface RolloutMeta {
  id?: string
  cwd?: string
  model?: string
}

/**
 * Start polling Codex local rollout files for quota/context updates.
 *
 * @param hub target status hub.
 * @param intervalMs polling interval in milliseconds.
 * @returns stop function.
 */
export function startCodexUsagePoller(
  hub: StatusHub,
  intervalMs = CODEX_USAGE_POLL_INTERVAL_MS,
): () => void {
  let stopped = false
  const lastSignatures = new Map<string, string>()

  async function poll(): Promise<void> {
    if (stopped) return
    try {
      const inputs = await readRecentCodexTokenSnapshots()
      for (const input of inputs) {
        if (!input.token) continue
        const key = snapshotKey(input)
        const signature = JSON.stringify({
          session: input.externalSessionId,
          workspace: input.workspacePath ?? input.cwd,
          model: input.model,
          token: input.token,
        })
        if (signature === lastSignatures.get(key)) continue
        lastSignatures.set(key, signature)
        hub.ingest(normalizeEvent(input))
      }
    } catch (err) {
      console.error('[codepulse] failed to poll Codex usage', err)
    }
  }

  const timer = setInterval(() => void poll(), intervalMs)
  timer.unref?.()
  void poll()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Read the newest Codex token_count event as a token_snapshot input.
 *
 * @param codexHome optional CODEX_HOME override for tests.
 * @returns token snapshot input, or undefined when no rollout token_count exists.
 */
export async function readLatestCodexTokenSnapshot(
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
): Promise<AgentEventInput | undefined> {
  return (await readRecentCodexTokenSnapshots(codexHome, 1))[0]
}

/**
 * Read recent Codex token_count events as token_snapshot inputs.
 *
 * @param codexHome optional CODEX_HOME override for tests.
 * @param maxSnapshots maximum number of distinct session/workspace snapshots.
 * @returns token snapshot inputs ordered by rollout mtime descending.
 */
export async function readRecentCodexTokenSnapshots(
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  maxSnapshots = MAX_CODEX_SNAPSHOTS,
): Promise<AgentEventInput[]> {
  const files: RolloutFile[] = []
  await collectRolloutFiles(join(codexHome, 'sessions'), files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const events: AgentEventInput[] = []
  const seen = new Set<string>()
  for (const file of files) {
    const tokenCount = await readLatestTokenCount(file.path)
    if (!tokenCount) continue
    const meta = await readRolloutMeta(file.path)
    const token = tokenFromTokenCount(tokenCount)
    if (!token) continue
    const event: AgentEventInput = {
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: meta?.id ?? sessionIdFromFile(file.path),
      cwd: meta?.cwd,
      workspacePath: meta?.cwd,
      model: meta?.model,
      token,
      raw: { source: 'codex', channel: 'rollout-poll', file: basename(file.path) },
    }
    const key = snapshotKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    events.push(event)
    if (events.length >= maxSnapshots) break
  }

  return events
}

async function collectRolloutFiles(dir: string, out: RolloutFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of [...entries].sort((a, b) => b.name.localeCompare(a.name))) {
    if (out.length >= MAX_ROLLOUT_FILES) return
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectRolloutFiles(path, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = await stat(path)
      out.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // Ignore files that disappear while Codex is writing.
    }
  }
}

async function readLatestTokenCount(file: string): Promise<Record<string, unknown> | undefined> {
  const lines = (await readTail(file)).trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    let item: unknown
    try {
      item = JSON.parse(lines[i] ?? '')
    } catch {
      continue
    }
    if (!isRecord(item) || item.type !== 'event_msg') continue
    const payload = item.payload
    if (isRecord(payload) && payload.type === 'token_count') return payload
  }
  return undefined
}

async function readRolloutMeta(file: string): Promise<RolloutMeta | undefined> {
  const lines = (await readHead(file)).split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    let item: unknown
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(item)) continue
    if (item.type === 'session_meta' || item.type === 'turn_context') {
      const payload = isRecord(item.payload) ? item.payload : undefined
      return {
        id: stringValue(payload?.id),
        cwd: stringValue(payload?.cwd),
        model: stringValue(payload?.model),
      }
    }
    if (item.type === 'event_msg') return undefined
  }
  return undefined
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

async function readHead(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, HEAD_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function tokenFromTokenCount(tokenCount: Record<string, unknown>): TokenPayload | undefined {
  const info = isRecord(tokenCount.info) ? tokenCount.info : {}
  const usage = recordValue(info.total_token_usage) ?? recordValue(info.last_token_usage)
  const contextUsage = recordValue(info.last_token_usage) ?? usage
  const contextWindow = numberValue(info.model_context_window) ?? DEFAULT_CODEX_CONTEXT_WINDOW
  const contextInput = codexContextInputTokens(contextUsage)
  const contextUsedPercent =
    contextWindow && contextInput > 0
      ? Math.min(100, (contextInput / contextWindow) * 100)
      : undefined
  const rateLimits = normalizeRateLimits(tokenCount.rate_limits ?? info.rate_limits)

  if (!usage && contextUsedPercent == null && !rateLimits) return undefined
  return {
    input: numberValue(usage?.input_tokens),
    cachedInput: numberValue(usage?.cached_input_tokens),
    output: numberValue(usage?.output_tokens),
    reasoningOutput: numberValue(usage?.reasoning_output_tokens),
    total: numberValue(usage?.total_tokens),
    contextUsedPercent,
    contextWindow,
    rateLimits,
    accuracy: 'estimated',
  }
}

function normalizeRateLimits(raw: unknown): TokenPayload['rateLimits'] {
  if (!isRecord(raw)) return undefined
  const fiveHour = normalizeWindow(raw.five_hour ?? raw.fiveHour ?? raw.primary)
  const sevenDay = normalizeWindow(raw.seven_day ?? raw.sevenDay ?? raw.secondary)
  if (!fiveHour && !sevenDay) return undefined
  return { fiveHour, sevenDay }
}

function codexContextInputTokens(usage: Record<string, unknown> | undefined): number {
  return numberValue(usage?.input_tokens) ?? numberValue(usage?.cached_input_tokens) ?? 0
}

function normalizeWindow(raw: unknown): NonNullable<TokenPayload['rateLimits']>['fiveHour'] {
  if (!isRecord(raw)) return undefined
  const usedPercent =
    numberValue(raw.used_percentage) ??
    numberValue(raw.usedPercent) ??
    numberValue(raw.used_percent)
  const resetsAt = numberValue(raw.resets_at) ?? numberValue(raw.resetsAt)
  const windowMinutes = numberValue(raw.window_minutes) ?? numberValue(raw.windowMinutes)
  if (usedPercent == null && resetsAt == null && windowMinutes == null) return undefined
  return { usedPercent, resetsAt, windowMinutes }
}

function sessionIdFromFile(path: string): string | undefined {
  const match = basename(path).match(/rollout-.+?-([0-9a-f-]{36})\.jsonl$/i)
  return match?.[1]
}

function snapshotKey(input: AgentEventInput): string {
  return [
    input.source,
    input.externalSessionId ?? '',
    input.workspacePath ?? input.cwd ?? '',
    input.model ?? '',
  ].join('\0')
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberValue(value: unknown): number | undefined {
  return parseTokenCount(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

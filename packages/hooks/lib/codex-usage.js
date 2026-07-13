/**
 * Best-effort Codex usage reader. Codex lifecycle hooks do not currently pass
 * the same usage payload shown by `/status`, but Codex writes `token_count`
 * events into its local rollout JSONL. This helper reads only the tail of the
 * matching rollout file and extracts the latest counters.
 */
import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const TAIL_BYTES = 1024 * 1024
const MAX_ROLLOUT_FILES = 500
const DEFAULT_CODEX_CONTEXT_WINDOW =
  parseTokenCount(process.env.CODEPULSE_CODEX_CONTEXT_WINDOW) ?? 256000

export async function readLatestCodexUsage(raw, options = {}) {
  try {
    const file = await findRolloutFile(raw, options)
    if (!file) return {}
    const lines = (await readTail(file)).trim().split(/\r?\n/)
    let tokenCount = null
    let taskStarted = null

    for (let i = lines.length - 1; i >= 0; i--) {
      let item
      try {
        item = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (item?.type !== 'event_msg') continue
      const payload = item.payload
      if (!tokenCount && payload?.type === 'token_count') tokenCount = payload
      if (!taskStarted && payload?.type === 'task_started') taskStarted = payload
      if (tokenCount && taskStarted) break
    }

    return tokenCount ? { ...toUsagePatch(tokenCount, taskStarted), usage_source_path: file } : {}
  } catch {
    return {}
  }
}

async function findRolloutFile(raw, options) {
  const directPath = stringValue(raw?.rollout_path) ?? stringValue(raw?.transcript_path)
  if (directPath) return directPath

  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const sessionsDir = join(codexHome, 'sessions')
  const sessionId =
    stringValue(raw?.session_id) ?? stringValue(raw?.sessionId) ?? stringValue(raw?.conversation_id)
  const cwd = stringValue(raw?.cwd) ?? stringValue(raw?.workspace) ?? stringValue(raw?.project_dir)
  const files = []
  await collectRolloutFiles(sessionsDir, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  if (sessionId) {
    const matched = files.find((file) => basename(file.path).includes(sessionId))
    if (matched) return matched.path
  }
  if (cwd) {
    const matched = await findByCwd(files, cwd)
    if (matched) return matched
  }
  if (cwd || sessionId) return undefined
  return files[0]?.path
}

async function findByCwd(files, cwd) {
  const target = normalizePath(cwd)
  for (const file of files) {
    const meta = await readRolloutMeta(file.path)
    if (normalizePath(meta?.cwd) === target) return file.path
  }
  return undefined
}

async function readRolloutMeta(file) {
  const lines = (await readHead(file)).split(/\r?\n/)
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item?.type === 'session_meta') return item.payload
      if (item?.type === 'turn_context') return item.payload
      if (item?.type === 'event_msg') return null
    } catch {
      continue
    }
  }
  return null
}

async function readHead(file, maxBytes = 64 * 1024) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

async function collectRolloutFiles(dir, out) {
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

async function readTail(file) {
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

function toUsagePatch(tokenCount, taskStarted) {
  const info = tokenCount.info ?? {}
  const usage = info.total_token_usage ?? info.last_token_usage
  const contextUsage = info.last_token_usage ?? usage
  const contextWindow =
    optionalNumber(info.model_context_window) ??
    optionalNumber(taskStarted?.model_context_window) ??
    DEFAULT_CODEX_CONTEXT_WINDOW
  const contextInput = codexContextInputTokens(contextUsage)
  const pct =
    contextWindow && contextInput > 0
      ? Math.min(100, (contextInput / contextWindow) * 100)
      : undefined
  const rawRateLimits = tokenCount.rate_limits ?? info.rate_limits
  const rateLimits = normalizeRateLimits(rawRateLimits)
  const rateLimitId = rateLimitString(rawRateLimits, 'limit_id', 'limitId')
  const rateLimitName = rateLimitString(rawRateLimits, 'limit_name', 'limitName')

  return {
    ...(usage ? { usage } : {}),
    ...(contextUsage ? { context_usage: contextUsage } : {}),
    ...(contextWindow ? { context_window_size: contextWindow } : {}),
    ...(pct != null ? { context_used_percent: pct } : {}),
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
    ...(rateLimitId ? { rate_limit_id: rateLimitId } : {}),
    ...(rateLimitName ? { rate_limit_name: rateLimitName } : {}),
  }
}

/**
 * Codex historically used primary=5h / secondary=weekly. After dropping the
 * 5h window, weekly often arrives only on `primary` (window_minutes=10080)
 * with `secondary: null`. Classify by window_minutes when available.
 */
function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return undefined

  const explicitFive = normalizeWindow(raw.five_hour ?? raw.fiveHour)
  const explicitSeven = normalizeWindow(raw.seven_day ?? raw.sevenDay)
  if (explicitFive || explicitSeven) {
    return {
      ...(explicitFive ? { five_hour: explicitFive } : {}),
      ...(explicitSeven ? { seven_day: explicitSeven } : {}),
    }
  }

  const primary = normalizeWindow(raw.primary)
  const secondary = normalizeWindow(raw.secondary)
  if (!primary && !secondary) return undefined

  const classified = classifyPrimarySecondaryWindows(primary, secondary)
  if (!classified.fiveHour && !classified.sevenDay) return undefined
  return {
    ...(classified.fiveHour ? { five_hour: classified.fiveHour } : {}),
    ...(classified.sevenDay ? { seven_day: classified.sevenDay } : {}),
  }
}

function classifyPrimarySecondaryWindows(primary, secondary) {
  const fiveHour = []
  const sevenDay = []

  for (const window of [primary, secondary]) {
    if (!window) continue
    const kind = classifyWindowKind(window)
    if (kind === 'fiveHour') fiveHour.push(window)
    else if (kind === 'sevenDay') sevenDay.push(window)
  }

  // Both windows present but neither has usable minutes: legacy primary/secondary.
  if (primary && secondary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { fiveHour: primary, sevenDay: secondary }
  }

  // Single unlabelled window: current Codex plans are weekly-only.
  if (primary && !secondary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { sevenDay: primary }
  }
  if (secondary && !primary && fiveHour.length === 0 && sevenDay.length === 0) {
    return { sevenDay: secondary }
  }

  return {
    fiveHour: fiveHour[0],
    sevenDay: sevenDay[0],
  }
}

/** Short windows (≤24h) map to fiveHour; longer (weekly etc.) map to sevenDay. */
function classifyWindowKind(window) {
  const minutes = window.window_minutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return 'unknown'
  if (minutes <= 24 * 60) return 'fiveHour'
  return 'sevenDay'
}

function codexContextInputTokens(usage) {
  return optionalNumber(usage?.input_tokens) ?? optionalNumber(usage?.cached_input_tokens) ?? 0
}

function normalizeWindow(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const used = raw.used_percentage ?? raw.usedPercent ?? raw.used_percent
  const resetsAt = raw.resets_at ?? raw.resetsAt
  const windowMinutes = raw.window_minutes ?? raw.windowMinutes
  return {
    ...(typeof used === 'number' ? { used_percentage: used } : {}),
    ...(typeof resetsAt === 'number' ? { resets_at: resetsAt } : {}),
    ...(typeof windowMinutes === 'number' ? { window_minutes: windowMinutes } : {}),
  }
}

function rateLimitString(raw, ...keys) {
  if (!raw || typeof raw !== 'object') return undefined
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizePath(value) {
  return stringValue(value)
    ?.replace(/\\/g, '/')
    ?.replace(/[\\/]+$/, '')
    .toLowerCase()
}

function numberValue(value) {
  return parseTokenCount(value) ?? 0
}

function optionalNumber(value) {
  return parseTokenCount(value)
}

function parseTokenCount(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().replace(/,/g, '').replace(/_/g, '')
  const match = normalized.match(/^(\d+(?:\.\d+)?)\s*([km])?(?:\s*(?:tok|tokens?))?$/i)
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2]?.toLowerCase()
  const multiplier = unit === 'm' ? 1_000_000 : unit === 'k' ? 1_000 : 1
  return Math.round(amount * multiplier)
}

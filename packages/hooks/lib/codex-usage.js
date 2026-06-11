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
const DEFAULT_CODEX_CONTEXT_WINDOW = Number(process.env.CODEPULSE_CODEX_CONTEXT_WINDOW) || 256000

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

    return tokenCount ? toUsagePatch(tokenCount, taskStarted) : {}
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

  if (cwd) {
    const matched = await findByCwd(files, cwd)
    if (matched) return matched
  }
  if (sessionId) {
    const matched = files.find((file) => basename(file.path).includes(sessionId))
    if (matched) return matched.path
  }
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

  for (const entry of entries) {
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
  const contextInput =
    numberValue(contextUsage?.input_tokens) + numberValue(contextUsage?.cached_input_tokens)
  const pct =
    contextWindow && contextInput > 0
      ? Math.min(100, (contextInput / contextWindow) * 100)
      : undefined
  const rateLimits = normalizeRateLimits(tokenCount.rate_limits)

  return {
    ...(usage ? { usage } : {}),
    ...(contextUsage ? { context_usage: contextUsage } : {}),
    ...(contextWindow ? { context_window_size: contextWindow } : {}),
    ...(pct != null ? { context_used_percent: pct } : {}),
    ...(rateLimits ? { rate_limits: rateLimits } : {}),
  }
}

function normalizeRateLimits(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const fiveHour = normalizeWindow(raw.five_hour ?? raw.fiveHour ?? raw.primary)
  const sevenDay = normalizeWindow(raw.seven_day ?? raw.sevenDay ?? raw.secondary)
  if (!fiveHour && !sevenDay) return undefined
  return {
    ...(fiveHour ? { five_hour: fiveHour } : {}),
    ...(sevenDay ? { seven_day: sevenDay } : {}),
  }
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

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function normalizePath(value) {
  return stringValue(value)
    ?.replace(/[\\/]+$/, '')
    .toLowerCase()
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

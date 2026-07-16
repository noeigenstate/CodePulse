/**
 * Best-effort Codex usage reader. Codex lifecycle hooks do not currently pass
 * the same usage payload shown by `/status`, but Codex writes `token_count`
 * events into its local rollout JSONL. This helper reads only the tail of the
 * matching rollout file and extracts the latest counters.
 */
import { readdir, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

/** Large multi-agent rollouts can bury the latest token_count past 1MB of tool noise. */
const TAIL_BYTES = 4 * 1024 * 1024
const META_HEAD_BYTES = 128 * 1024
const MAX_ROLLOUT_FILES = 800
const DEFAULT_CODEX_CONTEXT_WINDOW =
  parseTokenCount(process.env.CODEPULSE_CODEX_CONTEXT_WINDOW) ?? 256000

export async function readLatestCodexUsage(raw, options = {}) {
  try {
    const file = await findRolloutFile(raw, options)
    if (!file) return {}
    const lines = (await readTail(file)).trim().split(/\r?\n/)
    // Latest token_count often has context % but omits rate_limits until later.
    // Keep the newest event for context, and the newest *still-active* quota snapshot
    // for rate_limits. Never backfill limits whose resets_at are already past — that
    // re-applies pre-reset high usage and makes the UI jump after official reset.
    let tokenCount = null
    let tokenCountWithLimits = null
    let taskStarted = null
    const nowMs = Date.now()

    for (let i = lines.length - 1; i >= 0; i--) {
      let item
      try {
        item = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (item?.type !== 'event_msg') continue
      const payload = item.payload
      if (payload?.type === 'token_count') {
        if (!tokenCount) tokenCount = payload
        if (
          !tokenCountWithLimits &&
          tokenCountHasRateLimits(payload) &&
          rateLimitSnapshotIsActive(payload, nowMs)
        ) {
          tokenCountWithLimits = payload
        }
      }
      if (!taskStarted && payload?.type === 'task_started') taskStarted = payload
      if (tokenCount && tokenCountWithLimits && taskStarted) break
    }

    if (!tokenCount) return {}
    const patch = toUsagePatch(tokenCount, taskStarted)
    // Prefer limits on the latest event; only backfill from an earlier *active* snapshot.
    if (!patch.rate_limits && tokenCountWithLimits && tokenCountWithLimits !== tokenCount) {
      const limitPatch = toUsagePatch(tokenCountWithLimits, taskStarted)
      if (limitPatch.rate_limits && rateLimitPatchIsActive(limitPatch.rate_limits, nowMs)) {
        patch.rate_limits = limitPatch.rate_limits
        if (limitPatch.rate_limit_id) patch.rate_limit_id = limitPatch.rate_limit_id
        if (limitPatch.rate_limit_name) patch.rate_limit_name = limitPatch.rate_limit_name
      }
    } else if (patch.rate_limits && !rateLimitPatchIsActive(patch.rate_limits, nowMs)) {
      // Soft-reset (match local-server quota-watcher): keep windows at 0% with past
      // resets_at so the hub can show "可刷新" instead of sticky pre-reset high %.
      // Deleting limits left mergeToken holding the previous high sample forever.
      patch.rate_limits = softResetExpiredRateLimits(patch.rate_limits, nowMs)
    }
    return { ...patch, usage_source_path: file }
  } catch {
    return {}
  }
}

function tokenCountHasRateLimits(payload) {
  const raw = payload?.rate_limits ?? payload?.info?.rate_limits
  if (!raw || typeof raw !== 'object') return false
  return Boolean(
    raw.primary || raw.secondary || raw.five_hour || raw.fiveHour || raw.seven_day || raw.sevenDay,
  )
}

/**
 * True when at least one window still has a future resets_at (plan not rolled over),
 * or windows omit resets_at entirely (treat as usable). False when every known
 * resets_at is already in the past — that snapshot is pre-reset stale data.
 */
function rateLimitSnapshotIsActive(payload, nowMs = Date.now()) {
  if (!tokenCountHasRateLimits(payload)) return false
  const patch = toUsagePatch(payload, null)
  return rateLimitPatchIsActive(patch.rate_limits, nowMs)
}

function rateLimitPatchIsActive(rateLimits, nowMs = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return false
  const windows = [
    rateLimits.five_hour,
    rateLimits.seven_day,
    rateLimits.fiveHour,
    rateLimits.sevenDay,
  ].filter(Boolean)
  if (windows.length === 0) return false

  let sawReset = false
  for (const window of windows) {
    const resetsAt = window.resets_at ?? window.resetsAt
    if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) continue
    sawReset = true
    const resetMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
    if (resetMs > nowMs) return true
  }
  // No resets_at on any window → cannot prove expiry; allow (legacy payloads).
  if (!sawReset) return true
  // Every known reset is in the past → stale pre-reset snapshot.
  return false
}

/**
 * Soft-reset expired windows to 0% while keeping resets_at (past) so UI can show
 * "可刷新" instead of wiping limits (which left sticky pre-reset high % in the hub).
 */
function softResetExpiredRateLimits(rateLimits, nowMs = Date.now()) {
  if (!rateLimits || typeof rateLimits !== 'object') return rateLimits
  const out = { ...rateLimits }
  for (const key of ['five_hour', 'seven_day', 'fiveHour', 'sevenDay']) {
    if (!out[key] || typeof out[key] !== 'object') continue
    out[key] = softResetExpiredWindow(out[key], nowMs)
  }
  return out
}

function softResetExpiredWindow(window, nowMs) {
  if (!window || typeof window !== 'object') return window
  const resetsAt = window.resets_at ?? window.resetsAt
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) {
    return { ...window, used_percent: 0, usedPercent: 0 }
  }
  const resetMs = resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
  if (resetMs > nowMs) return window
  return {
    ...window,
    used_percent: 0,
    usedPercent: 0,
  }
}

/**
 * Resolve which rollout JSONL to read.
 *
 * IMPORTANT: `rollout_path` / `transcript_path` from Codex hooks are only
 * **candidates**. After fork/resume they often still point at the parent
 * session (e.g. Spark 0%) while the live thread has the real weekly bucket.
 */
async function findRolloutFile(raw, options) {
  const codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const sessionsDir = join(codexHome, 'sessions')
  const sessionIds = collectSessionIds(raw)
  const cwd = stringValue(raw?.cwd) ?? stringValue(raw?.workspace) ?? stringValue(raw?.project_dir)
  const model = stringValue(raw?.model)
  const files = []
  await collectRolloutFiles(sessionsDir, files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const candidates = []
  const seen = new Set()
  const addCandidate = (path, mtimeMs = 0) => {
    const key = normalizePath(path)
    if (!key || seen.has(key)) return
    seen.add(key)
    candidates.push({ path, mtimeMs })
  }

  // 1) Hook-provided paths — candidates only, never absolute winners.
  for (const key of ['rollout_path', 'transcript_path', 'token_source_path', 'usage_source_path']) {
    const directPath = stringValue(raw?.[key])
    if (!directPath) continue
    try {
      const info = await stat(directPath)
      addCandidate(directPath, info.mtimeMs)
    } catch {
      // Path may be stale after resume; ignore.
    }
  }

  // 2) Filename / meta session ids (fork thread id vs parent id).
  for (const sessionId of sessionIds) {
    const matched = files.find((file) => basename(file.path).includes(sessionId))
    if (matched) addCandidate(matched.path, matched.mtimeMs)
  }

  // 3) Same workspace cwd (forks share cwd with parent).
  if (cwd) {
    const target = normalizePath(cwd)
    for (const file of files) {
      const meta = await readRolloutMeta(file.path)
      if (normalizePath(meta?.cwd) === target) addCandidate(file.path, file.mtimeMs)
    }
  }

  if (candidates.length === 0) {
    // Soft fallback only when the hook gave no binding at all.
    if (sessionIds.length === 0 && !cwd) return files[0]?.path
    return undefined
  }

  if (candidates.length === 1) return candidates[0].path

  // Among candidates, pick the rollout that best matches the active model family
  // and has fresh main-plan weekly data (not idle Spark 0% from a parent thread).
  let best = null
  for (const candidate of candidates) {
    const score = await scoreRolloutForQuota(candidate.path, candidate.mtimeMs, model, sessionIds)
    if (!best || score > best.score) best = { path: candidate.path, score }
  }
  return best?.path
}

function collectSessionIds(raw) {
  if (!raw || typeof raw !== 'object') return []
  const keys = [
    'session_id',
    'sessionId',
    'conversation_id',
    'conversationId',
    'thread_id',
    'threadId',
    'id',
  ]
  const ids = []
  for (const key of keys) {
    const value = stringValue(raw[key])
    if (value) ids.push(value)
  }
  return [...new Set(ids)]
}

/**
 * Forked sessions write a first session_meta without cwd, then another with cwd.
 * Older code returned the first meta and broke cwd matching for forks.
 */
async function readRolloutMeta(file) {
  const lines = (await readHead(file, META_HEAD_BYTES)).split(/\r?\n/)
  let meta = {}
  let sawEvent = false

  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line)
      if (item?.type === 'session_meta' && item.payload && typeof item.payload === 'object') {
        meta = { ...meta, ...item.payload }
        continue
      }
      if (item?.type === 'turn_context' && item.payload && typeof item.payload === 'object') {
        meta = { ...meta, ...item.payload }
        if (meta.cwd) return meta
        continue
      }
      if (item?.type === 'event_msg') {
        sawEvent = true
        // Enough header context once we have cwd after events start.
        if (meta.cwd) return meta
      }
      if (sawEvent && meta.cwd) return meta
    } catch {
      continue
    }
  }

  return Object.keys(meta).length > 0 ? meta : null
}

/**
 * Score a rollout for quota display.
 * @param {string} [model] Active Codex model id (e.g. gpt-5.6-sol / gpt-5.3-codex-spark).
 * @param {string[]} [sessionIds] Hook session / conversation ids — path match wins.
 */
async function scoreRolloutForQuota(path, mtimeMs, model, sessionIds = []) {
  // Newer mtime is a weak signal among same-cwd / candidate sessions.
  let score = mtimeMs
  const preferSpark = isSparkModelName(model)
  const base = basename(path)
  for (const sessionId of sessionIds) {
    if (sessionId && base.includes(sessionId)) {
      // Explicit session binding beats mtime / sibling cwd rollouts.
      score += 1e15
      break
    }
  }
  try {
    const lines = (await readTail(path, 512 * 1024)).trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      let item
      try {
        item = JSON.parse(lines[i])
      } catch {
        continue
      }
      if (item?.type !== 'event_msg' || item?.payload?.type !== 'token_count') continue
      const raw = item.payload.rate_limits ?? item.payload.info?.rate_limits
      if (!raw || typeof raw !== 'object') continue

      score += 1e11
      const limitId = String(raw.limit_id ?? raw.limitId ?? '').toLowerCase()
      const limitName = String(raw.limit_name ?? raw.limitName ?? '').toLowerCase()
      const bucketSpark =
        limitId.includes('bengalfox') ||
        limitId.includes('spark') ||
        limitName.includes('spark') ||
        limitName.includes('bengalfox')

      // Strongly prefer bucket family that matches the active model.
      if (preferSpark) {
        if (bucketSpark) score += 1e14
        else score += 1e9
      } else {
        // Non-Spark models (gpt-5.6-sol, etc.): main codex weekly >> idle Spark 0%.
        if (!bucketSpark && (limitId === 'codex' || !limitId || limitId === 'default')) {
          score += 1e14
        } else if (!bucketSpark) {
          score += 1e13
        } else {
          // Spark bucket while not on Spark — heavy penalty so parent fork loses.
          score -= 1e14
        }
      }
      // Prefer *active* (not yet reset) snapshots — never prefer higher used%
      // (that made pre-reset 80% sessions beat post-reset 5% ones).
      if (rateLimitSnapshotIsActive(item.payload, Date.now())) score += 5e12
      break
    }
  } catch {
    // ignore scoring failures
  }
  return score
}

function isSparkModelName(model) {
  const value = String(model ?? '').toLowerCase()
  return value.includes('spark') || value.includes('bengalfox')
}

async function readHead(file, maxBytes = META_HEAD_BYTES) {
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

async function readTail(file, maxBytes = TAIL_BYTES) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function toUsagePatch(tokenCount, taskStarted) {
  const info = tokenCount.info ?? {}
  // total_token_usage is cumulative session burn — never use it for the context bar
  // (that alone makes usage jump 10%→80%→15% as fields appear/disappear).
  const usage = info.total_token_usage ?? info.last_token_usage
  const contextUsage = info.last_token_usage
  const contextWindow =
    optionalNumber(info.model_context_window) ??
    optionalNumber(taskStarted?.model_context_window) ??
    DEFAULT_CODEX_CONTEXT_WINDOW
  const contextInput = codexContextInputTokens(contextUsage)
  const pct =
    contextUsage && contextWindow && contextInput > 0
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

/**
 * Current context occupancy for Codex is the *last model call* input size.
 * Prefer non-cached input_tokens; fall back to cached-only only when input is absent.
 * Do not sum input+cached (Codex often double-counts cache in both fields).
 */
function codexContextInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0
  return optionalNumber(usage.input_tokens) ?? optionalNumber(usage.cached_input_tokens) ?? 0
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

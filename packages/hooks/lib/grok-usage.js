/**
 * Best-effort Grok usage reader.
 *
 * Grok lifecycle hooks do not currently embed token / credit payloads.
 * During an active turn the session often only has `summary.json` + `updates.jsonl`
 * (`params._meta.totalTokens` is the live context size). `signals.json` is usually
 * written after the turn ends and remains the preferred source when present.
 * SuperGrok credit usage is logged as `billing: fetched credits config` in
 * `logs/unified.jsonl`. This helper reads only local files and never calls the network.
 */
import { readdir, readFile, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TAIL_BYTES = 1024 * 1024
const MAX_SESSION_SCAN = 400
const BILLING_MSG = 'billing: fetched credits config'
/** Live context markers we accept under `params._meta` (not turn_completed.usage). */
const META_TOTAL_TOKEN_KEYS = ['totalTokens', 'total_tokens', 'contextTokens', 'context_tokens']

/**
 * @param {Record<string, unknown>} raw hook payload
 * @param {{ grokHome?: string }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readLatestGrokUsage(raw, options = {}) {
  try {
    const grokHome = options.grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
    const sessionDir = await findSessionDir(raw, grokHome)
    const contextPatch = sessionDir ? await readSessionUsage(sessionDir, grokHome) : {}
    const billingPatch = await readBillingQuota(grokHome)
    const usageSourcePath =
      contextPatch.usage_source_path ?? billingPatch.usage_source_path ?? undefined

    const patch = {
      ...billingPatch,
      ...contextPatch,
      ...(usageSourcePath ? { usage_source_path: usageSourcePath } : {}),
    }
    // Prefer session model; fall back to nothing from billing.
    if (!patch.model && contextPatch.model) patch.model = contextPatch.model
    delete patch._billingSourcePath
    return hasUsefulPatch(patch) ? patch : {}
  } catch {
    return {}
  }
}

async function findSessionDir(raw, grokHome) {
  const sessionsRoot = join(grokHome, 'sessions')
  const sessionId =
    stringValue(raw?.session_id) ?? stringValue(raw?.sessionId) ?? stringValue(raw?.conversation_id)
  const cwd =
    stringValue(raw?.cwd) ??
    stringValue(raw?.workspaceRoot) ??
    stringValue(raw?.workspace_root) ??
    stringValue(raw?.workspace) ??
    stringValue(raw?.project_dir)

  if (cwd) {
    const encoded = encodeCwdDirName(cwd)
    const groupDir = join(sessionsRoot, encoded)
    if (sessionId) {
      const direct = join(groupDir, sessionId)
      if (
        (await pathExists(join(direct, 'signals.json'))) ||
        (await pathExists(join(direct, 'summary.json'))) ||
        (await pathExists(join(direct, 'updates.jsonl')))
      ) {
        return direct
      }
    }
    const latestInGroup = await latestSessionInDir(groupDir)
    if (latestInGroup) return latestInGroup
  }

  if (sessionId) {
    const byId = await findSessionById(sessionsRoot, sessionId)
    if (byId) return byId
  }

  if (cwd) {
    // Fall back to scanning summary.json cwd when encoding differs.
    const byCwd = await findSessionByCwd(sessionsRoot, cwd)
    if (byCwd) return byCwd
  }

  // Active session for this machine (best-effort when hook payload is sparse).
  const active = await readActiveSession(grokHome, cwd, sessionId)
  if (active) {
    const byId = await findSessionById(sessionsRoot, active)
    if (byId) return byId
  }

  if (cwd || sessionId) return undefined
  return latestSessionInTree(sessionsRoot)
}

async function findSessionById(sessionsRoot, sessionId) {
  const stack = [sessionsRoot]
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_SESSION_SCAN) {
    const dir = stack.pop()
    if (!dir) break
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      scanned += 1
      const full = join(dir, entry.name)
      if (entry.name === sessionId) {
        if (await pathExists(join(full, 'signals.json'))) return full
        if (await pathExists(join(full, 'summary.json'))) return full
        if (await pathExists(join(full, 'updates.jsonl'))) return full
      }
      // Session groups are one level deep; still walk a couple of levels.
      if (scanned < MAX_SESSION_SCAN) stack.push(full)
    }
  }
  return undefined
}

async function findSessionByCwd(sessionsRoot, cwd) {
  const target = normalizePath(cwd)
  const candidates = []
  await collectSessionDirs(sessionsRoot, candidates)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const item of candidates.slice(0, 40)) {
    const summary = await readJson(join(item.path, 'summary.json'))
    const summaryCwd = stringValue(summary?.info?.cwd) ?? stringValue(summary?.cwd)
    if (normalizePath(summaryCwd) === target) return item.path
  }
  return undefined
}

async function latestSessionInDir(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  const sessions = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    const mtimeMs = await sessionMtime(full)
    if (mtimeMs != null) sessions.push({ path: full, mtimeMs })
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return sessions[0]?.path
}

async function latestSessionInTree(sessionsRoot) {
  const candidates = []
  await collectSessionDirs(sessionsRoot, candidates)
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return candidates[0]?.path
}

async function collectSessionDirs(root, out, depth = 0) {
  if (out.length >= MAX_SESSION_SCAN || depth > 3) return
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    const mtimeMs = await sessionMtime(full)
    if (mtimeMs != null) {
      out.push({ path: full, mtimeMs })
      if (out.length >= MAX_SESSION_SCAN) return
      continue
    }
    await collectSessionDirs(full, out, depth + 1)
  }
}

async function sessionMtime(dir) {
  for (const name of ['signals.json', 'updates.jsonl', 'summary.json']) {
    try {
      const s = await stat(join(dir, name))
      return s.mtimeMs
    } catch {
      // try next
    }
  }
  return null
}

async function readActiveSession(grokHome, cwd, sessionId) {
  if (sessionId) return sessionId
  const active = await readJson(join(grokHome, 'active_sessions.json'))
  if (!Array.isArray(active) || active.length === 0) return undefined
  const target = normalizePath(cwd)
  if (target) {
    const match = active.find((row) => normalizePath(row?.cwd) === target)
    if (match?.session_id) return stringValue(match.session_id)
  }
  // Prefer most recently opened.
  const sorted = [...active].sort((a, b) => {
    const at = Date.parse(a?.opened_at ?? '') || 0
    const bt = Date.parse(b?.opened_at ?? '') || 0
    return bt - at
  })
  return stringValue(sorted[0]?.session_id)
}

/**
 * Build a usage patch for one session directory.
 *
 * Priority for context:
 * 1. `signals.json` when it already has context fields (post-turn / completed).
 * 2. Live tail of `updates.jsonl` → last valid `params._meta.totalTokens`
 *    (must be last, not max — context compression can lower the number).
 *    Window size comes from `models_cache.json` for the active model.
 * Never use `turn_completed.usage.totalTokens` (cumulative model calls).
 *
 * @param {string} sessionDir
 * @param {string} grokHome
 */
async function readSessionUsage(sessionDir, grokHome) {
  const signals = await readJson(join(sessionDir, 'signals.json'))
  const summary = await readJson(join(sessionDir, 'summary.json'))
  const live = await readLiveContextFromUpdates(sessionDir)
  if (!signals && !summary && !live) return {}

  const model =
    stringValue(signals?.primaryModelId) ??
    stringValue(summary?.current_model_id) ??
    stringValue(live?.model) ??
    (Array.isArray(signals?.modelsUsed) ? stringValue(signals.modelsUsed[0]) : undefined)

  const signalTokens = optionalNumber(signals?.contextTokensUsed)
  const signalWindow = optionalNumber(signals?.contextWindowTokens)
  const signalUsage = optionalNumber(signals?.contextWindowUsage)
  const hasSignalContext = signalTokens != null || signalWindow != null || signalUsage != null

  let contextTokensUsed = hasSignalContext ? signalTokens : undefined
  let contextWindowTokens = hasSignalContext ? signalWindow : undefined
  let contextWindowUsage = hasSignalContext ? signalUsage : undefined
  let usageSource = hasSignalContext
    ? join(sessionDir, 'signals.json')
    : summary
      ? join(sessionDir, 'summary.json')
      : undefined

  // Active turns often lack signals.json; use live updates + model window cache.
  if (!hasSignalContext && live?.totalTokens != null) {
    contextTokensUsed = live.totalTokens
    usageSource = live.sourcePath
    if (model) {
      const cachedWindow = await readModelContextWindow(grokHome, model)
      if (cachedWindow != null) contextWindowTokens = cachedWindow
    }
  } else if (hasSignalContext && contextWindowTokens == null && model) {
    const cachedWindow = await readModelContextWindow(grokHome, model)
    if (cachedWindow != null) contextWindowTokens = cachedWindow
  }

  const contextUsedPercent =
    contextWindowUsage != null
      ? clampPercent(contextWindowUsage)
      : percentOf(contextTokensUsed, contextWindowTokens)

  const usage =
    contextTokensUsed != null
      ? {
          input_tokens: contextTokensUsed,
          total_tokens: contextTokensUsed,
        }
      : undefined
  const contextUsage =
    contextTokensUsed != null
      ? {
          input_tokens: contextTokensUsed,
          total_tokens: contextTokensUsed,
        }
      : undefined

  const patch = {
    ...(model ? { model } : {}),
    ...(usage ? { usage } : {}),
    ...(contextUsage ? { context_usage: contextUsage } : {}),
    ...(contextWindowTokens != null ? { context_window_size: contextWindowTokens } : {}),
    ...(contextUsedPercent != null ? { context_used_percent: contextUsedPercent } : {}),
    ...(usageSource ? { usage_source_path: usageSource } : {}),
  }
  return patch
}

/**
 * Scan the tail of `updates.jsonl` from the end and return the last valid
 * live context size from `params._meta.totalTokens`.
 *
 * @param {string} sessionDir
 * @returns {Promise<{ totalTokens: number, model?: string, sourcePath: string } | null>}
 */
async function readLiveContextFromUpdates(sessionDir) {
  const updatesPath = join(sessionDir, 'updates.jsonl')
  let text
  try {
    text = await readTail(updatesPath)
  } catch {
    return null
  }
  if (!text) return null

  const lines = text.trim().split(/\r?\n/)
  // Walk from the end so we get the *last* valid live value (not max).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (!item || typeof item !== 'object') continue

    // Only `params._meta.totalTokens` is live context occupancy.
    // Do not read `turn_completed.usage.totalTokens` (cumulative model calls).
    const totalTokens = extractMetaTotalTokens(item)
    if (totalTokens == null || totalTokens < 0) continue

    const model =
      stringValue(item?.params?.model) ??
      stringValue(item?.params?.modelId) ??
      stringValue(item?.params?.model_id) ??
      stringValue(item?.model) ??
      stringValue(item?.modelId)

    return {
      totalTokens,
      ...(model ? { model } : {}),
      sourcePath: updatesPath,
    }
  }
  return null
}

/**
 * Live context size lives only under `_meta` / `params._meta`.
 * Cumulative `usage.totalTokens` on turn_completed events is intentionally ignored.
 * @param {Record<string, unknown>} item
 */
function extractMetaTotalTokens(item) {
  const candidates = []
  if (item.params && typeof item.params === 'object') {
    const params = /** @type {Record<string, unknown>} */ (item.params)
    if (params._meta && typeof params._meta === 'object') candidates.push(params._meta)
    if (params.meta && typeof params.meta === 'object') candidates.push(params.meta)
  }
  if (item._meta && typeof item._meta === 'object') candidates.push(item._meta)
  if (item.meta && typeof item.meta === 'object') candidates.push(item.meta)

  for (const meta of candidates) {
    const record = /** @type {Record<string, unknown>} */ (meta)
    for (const key of META_TOTAL_TOKEN_KEYS) {
      const n = optionalNumber(record[key])
      if (n != null) return n
    }
  }
  return undefined
}

/**
 * Look up the model's context window from `~/.grok/models_cache.json`.
 * @param {string} grokHome
 * @param {string} modelId
 */
async function readModelContextWindow(grokHome, modelId) {
  if (!modelId) return undefined
  const cachePaths = [
    join(grokHome, 'models_cache.json'),
    join(grokHome, 'cache', 'models_cache.json'),
    join(grokHome, 'models', 'models_cache.json'),
  ]
  for (const path of cachePaths) {
    const cache = await readJson(path)
    if (!cache) continue
    const window = lookupModelContextWindow(cache, modelId)
    if (window != null) return window
  }
  return undefined
}

/**
 * @param {unknown} cache
 * @param {string} modelId
 */
function lookupModelContextWindow(cache, modelId) {
  if (!cache || typeof cache !== 'object') return undefined
  const root = /** @type {Record<string, unknown>} */ (cache)
  const target = modelId.toLowerCase()

  // Map form: { "grok-4.5": { context_window: 500000 } }
  const direct = root[modelId] ?? root[target]
  const fromDirect = contextWindowFromEntry(direct)
  if (fromDirect != null) return fromDirect

  // Nested models / data arrays
  for (const key of ['models', 'data', 'items', 'entries']) {
    const list = root[key]
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue
      const rec = /** @type {Record<string, unknown>} */ (entry)
      const id =
        stringValue(rec.id) ??
        stringValue(rec.modelId) ??
        stringValue(rec.model_id) ??
        stringValue(rec.name)
      if (!id || id.toLowerCase() !== target) continue
      const w = contextWindowFromEntry(rec)
      if (w != null) return w
    }
  }

  // Nested map under models: { models: { "grok-4.5": {...} } }
  if (root.models && typeof root.models === 'object' && !Array.isArray(root.models)) {
    const map = /** @type {Record<string, unknown>} */ (root.models)
    const w = contextWindowFromEntry(map[modelId] ?? map[target])
    if (w != null) return w
  }

  return undefined
}

/**
 * @param {unknown} entry
 */
function contextWindowFromEntry(entry) {
  if (entry == null) return undefined
  if (typeof entry === 'number') return optionalNumber(entry)
  if (typeof entry !== 'object') return undefined
  const rec = /** @type {Record<string, unknown>} */ (entry)
  return (
    optionalNumber(rec.context_window) ??
    optionalNumber(rec.contextWindow) ??
    optionalNumber(rec.context_window_tokens) ??
    optionalNumber(rec.contextWindowTokens) ??
    optionalNumber(rec.context_window_size) ??
    optionalNumber(rec.contextWindowSize) ??
    optionalNumber(rec.max_context) ??
    optionalNumber(rec.maxContext)
  )
}

async function readBillingQuota(grokHome) {
  const logPath = join(grokHome, 'logs', 'unified.jsonl')
  let text
  try {
    text = await readTail(logPath)
  } catch {
    return {}
  }
  if (!text) return {}

  const lines = text.trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes(BILLING_MSG)) continue
    let item
    try {
      item = JSON.parse(line)
    } catch {
      continue
    }
    if (item?.msg !== BILLING_MSG) continue
    const config = item?.ctx?.config
    if (!config || typeof config !== 'object') continue

    const usedPercent = normalizeCreditPercent(config.creditUsagePercent)
    const periodEnd =
      stringValue(config.billingPeriodEnd) ??
      stringValue(config.currentPeriod?.end) ??
      stringValue(config.current_period?.end)
    const resetsAt = periodEnd ? Math.floor(Date.parse(periodEnd) / 1000) : undefined
    const periodType =
      stringValue(config.currentPeriod?.type) ?? stringValue(config.current_period?.type)
    const windowMinutes =
      periodType && /week/i.test(periodType)
        ? 7 * 24 * 60
        : periodType && /day/i.test(periodType)
          ? 24 * 60
          : undefined

    if (usedPercent == null && resetsAt == null) continue

    const rateLimits = {
      seven_day: {
        ...(usedPercent != null ? { used_percentage: usedPercent } : {}),
        ...(resetsAt != null && Number.isFinite(resetsAt) ? { resets_at: resetsAt } : {}),
        ...(windowMinutes != null ? { window_minutes: windowMinutes } : {}),
      },
    }

    const tier = stringValue(item?.ctx?.subscriptionTier)
    return {
      rate_limits: rateLimits,
      ...(tier ? { rate_limit_name: tier, rate_limit_id: tier.toLowerCase() } : {}),
      usage_source_path: logPath,
      _billingSourcePath: logPath,
    }
  }
  return {}
}

/**
 * Grok logs `creditUsagePercent` on a 0–100 scale (e.g. 1.0 = 1%).
 * Guard against accidental 0–1 fractions only when the value is clearly a fraction
 * and not a whole percent: values in (0, 1) stay as-is * 100 only if field name
 * implies ratio — here the field is Percent, so keep the raw number.
 */
function normalizeCreditPercent(value) {
  const n = optionalNumber(value)
  if (n == null) return undefined
  return clampPercent(n)
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return undefined
  return Math.min(100, Math.max(0, value))
}

function percentOf(value, total) {
  if (value == null || total == null || total <= 0) return undefined
  return clampPercent((value / total) * 100)
}

function hasUsefulPatch(patch) {
  return Boolean(
    patch.usage ||
    patch.context_usage ||
    patch.context_window_size != null ||
    patch.context_used_percent != null ||
    patch.rate_limits ||
    patch.model,
  )
}

function encodeCwdDirName(cwd) {
  // Grok stores session groups as URL-encoded absolute paths.
  return encodeURIComponent(cwd)
}

async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return null
  }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readTail(file, maxBytes = TAIL_BYTES) {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    if (size <= 0) return ''
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
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

function optionalNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

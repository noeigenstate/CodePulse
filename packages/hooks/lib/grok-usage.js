/**
 * Best-effort Grok usage reader.
 *
 * Grok lifecycle hooks do not currently embed token / credit payloads.
 * Context is written to each session's `signals.json`, and SuperGrok credit
 * usage is logged as `billing: fetched credits config` in `logs/unified.jsonl`.
 * This helper reads only local files and never calls the network.
 */
import { readdir, readFile, open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TAIL_BYTES = 1024 * 1024
const MAX_SESSION_SCAN = 400
const BILLING_MSG = 'billing: fetched credits config'

/**
 * @param {Record<string, unknown>} raw hook payload
 * @param {{ grokHome?: string }} [options]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readLatestGrokUsage(raw, options = {}) {
  try {
    const grokHome = options.grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
    const sessionDir = await findSessionDir(raw, grokHome)
    const contextPatch = sessionDir ? await readSessionUsage(sessionDir) : {}
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
        (await pathExists(join(direct, 'summary.json')))
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
  for (const name of ['signals.json', 'summary.json']) {
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

async function readSessionUsage(sessionDir) {
  const signals = await readJson(join(sessionDir, 'signals.json'))
  const summary = await readJson(join(sessionDir, 'summary.json'))
  if (!signals && !summary) return {}

  const model =
    stringValue(signals?.primaryModelId) ??
    stringValue(summary?.current_model_id) ??
    (Array.isArray(signals?.modelsUsed) ? stringValue(signals.modelsUsed[0]) : undefined)

  const contextTokensUsed = optionalNumber(signals?.contextTokensUsed)
  const contextWindowTokens = optionalNumber(signals?.contextWindowTokens)
  const contextWindowUsage = optionalNumber(signals?.contextWindowUsage)
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
    usage_source_path: join(sessionDir, signals ? 'signals.json' : 'summary.json'),
  }
  return patch
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

/**
 * Reads Kimi Code's latest model and context usage from local session files.
 * Account quotas are fetched separately by the local server from Kimi's managed
 * usage endpoint, keeping OAuth material out of hook payloads.
 *
 * @module hooks/lib/kimi-usage
 */
import { open, readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const TAIL_BYTES = 1024 * 1024

/**
 * Builds a best-effort usage patch for a Kimi hook payload.
 *
 * @param {Record<string, unknown>} raw Native hook payload.
 * @param {{ kimiHome?: string }} [options] Test and installation overrides.
 * @returns {Promise<Record<string, unknown>>} A safe patch, or an empty object.
 */
export async function readLatestKimiUsage(raw, options = {}) {
  try {
    const kimiHome = options.kimiHome ?? process.env.KIMI_CODE_HOME ?? join(homedir(), '.kimi-code')
    const sessionDir = await findSessionDir(raw, kimiHome)
    if (!sessionDir) return {}
    return await readWireUsage(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
  } catch {
    return {}
  }
}

/** Locates a session by id first, then by normalized working directory. */
async function findSessionDir(raw, kimiHome) {
  const sessionId = stringValue(raw?.session_id) ?? stringValue(raw?.sessionId)
  const cwd = stringValue(raw?.cwd) ?? stringValue(raw?.workspace) ?? stringValue(raw?.project_dir)
  const rows = await readSessionIndex(kimiHome)

  if (sessionId) {
    const exact = [...rows].reverse().find((row) => row.sessionId === sessionId)
    if (exact && (await pathExists(exact.sessionDir))) return exact.sessionDir
  }
  if (cwd) {
    const normalized = normalizePath(cwd)
    const exact = [...rows].reverse().find((row) => normalizePath(row.workDir) === normalized)
    if (exact && (await pathExists(exact.sessionDir))) return exact.sessionDir
  }
  if (sessionId) return findSessionById(join(kimiHome, 'sessions'), sessionId)
  return undefined
}

/** Reads Kimi's append-only session index without trusting malformed rows. */
async function readSessionIndex(kimiHome) {
  let text
  try {
    text = await readFile(join(kimiHome, 'session_index.jsonl'), 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      const sessionId = stringValue(row.sessionId) ?? stringValue(row.session_id)
      const sessionDir = stringValue(row.sessionDir) ?? stringValue(row.session_dir)
      const workDir = stringValue(row.workDir) ?? stringValue(row.cwd)
      if (sessionId && sessionDir) rows.push({ sessionId, sessionDir, workDir })
    } catch {
      // Ignore a partially written final line.
    }
  }
  return rows
}

async function findSessionById(root, sessionId) {
  let groups
  try {
    groups = await readdir(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue
    const candidate = join(root, group.name, sessionId)
    if (await pathExists(candidate)) return candidate
  }
  return undefined
}

/** Reads the last usage record and matching request metadata from the wire tail. */
async function readWireUsage(wirePath) {
  let text
  try {
    text = await readTail(wirePath)
  } catch {
    return {}
  }
  const lines = text.trim().split(/\r?\n/)
  let usageRecord
  let requestRecord
  let usageRequestRecord
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const row = JSON.parse(lines[index])
      if (row?.type === 'llm.request') requestRecord = row
      if (row?.type === 'usage.record') {
        usageRecord = row
        usageRequestRecord = requestRecord
      }
    } catch {
      // Tail reads can begin inside a JSON line.
    }
  }
  const usage = usageRecord?.usage
  if (!usage || typeof usage !== 'object') return {}
  const inputOther = optionalNumber(usage.inputOther) ?? 0
  const cacheRead = optionalNumber(usage.inputCacheRead) ?? 0
  const cacheCreation = optionalNumber(usage.inputCacheCreation) ?? 0
  const output = optionalNumber(usage.output)
  const input = inputOther + cacheRead + cacheCreation
  const pairedRemaining = optionalNumber(usageRequestRecord?.maxTokens)
  const latestRemaining = optionalNumber(requestRecord?.maxTokens)
  const contextWindow = pairedRemaining != null ? input + pairedRemaining : undefined
  const contextUsed =
    contextWindow != null && latestRemaining != null
      ? Math.min(contextWindow, Math.max(0, contextWindow - latestRemaining))
      : input
  const model = stringValue(usageRecord.model) ?? stringValue(requestRecord?.modelAlias)
  const effort = stringValue(requestRecord?.thinkingEffort)

  return {
    ...(model ? { model } : {}),
    ...(effort ? { thinking_effort: effort } : {}),
    usage: {
      input_tokens: input,
      cached_input_tokens: cacheRead,
      ...(output != null ? { output_tokens: output } : {}),
      total_tokens: input + (output ?? 0),
    },
    context_usage: { input_tokens: contextUsed, total_tokens: contextUsed },
    ...(contextWindow != null
      ? {
          context_window_size: contextWindow,
          context_used_percent: clampPercent((contextUsed / contextWindow) * 100),
        }
      : {}),
    usage_source_path: wirePath,
  }
}

async function readTail(path) {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, Math.max(0, size - length))
    return buffer.toString('utf8')
  } finally {
    await handle.close()
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

function stringValue(value) {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizePath(value) {
  return stringValue(value)
    ?.replace(/\\/g, '/')
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

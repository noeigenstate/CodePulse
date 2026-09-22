/**
 * OpenCode 本地会话库读取器。OpenCode 把会话与累计 token 用量持久化在
 * `~/.local/share/opencode/opencode.db`（SQLite）；这里把会话行缩减为
 * session-sync 需要的快照。只读打开，绝不写入。
 *
 * @module local-server/opencode-db
 */
import Database from 'better-sqlite3'
import { join } from 'node:path'
import type { TokenPayload } from '@codepulse/shared'

/** One OpenCode session reduced to session-sync's snapshot shape. */
export interface OpencodeSessionSnapshot {
  sessionId: string
  cwd: string
  /** Last activity timestamp in epoch milliseconds. */
  mtimeMs: number
  sourcePath: string
  model?: string
  modelObservedAt?: number
  token?: TokenPayload
}

interface OpencodeSessionRow {
  id?: unknown
  directory?: unknown
  model?: unknown
  tokens_input?: unknown
  tokens_output?: unknown
  tokens_reasoning?: unknown
  tokens_cache_read?: unknown
  tokens_cache_write?: unknown
  time_created?: unknown
  time_updated?: unknown
}

const MAX_SESSIONS = 200
/** Message rows scanned per read for liveness and last-request context usage. */
const MAX_MESSAGE_ROWS = 600
/** MiMo v2.5/v2.6 series expose a 1M window; override per install if models differ. */
const DEFAULT_CONTEXT_WINDOW = 1_048_576

/** Latest per-session message state derived from assistant message rows. */
interface OpencodeMessageState {
  /** Most recent message write time in epoch milliseconds. */
  activityAt: number
  /** Last completed request's context footprint (fresh input plus cache tokens). */
  contextTokens?: { input: number; cached: number }
}

/**
 * 读取 OpenCode 数据目录中的最近会话（兼容新旧两张表）。
 *
 * @param opencodeHome OpenCode 数据目录（内含 `opencode.db`）。
 * @returns 按最近活动排序的会话快照。
 */
export function readOpencodeSessions(opencodeHome: string): OpencodeSessionSnapshot[] {
  const sourcePath = join(opencodeHome, 'opencode.db')
  const db = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    const table = findSessionTable(db)
    if (!table) return []
    const rows = db
      .prepare(
        `SELECT id, directory, model, tokens_input, tokens_output, tokens_reasoning, ` +
          `tokens_cache_read, tokens_cache_write, time_created, time_updated ` +
          `FROM ${table} ORDER BY time_updated DESC LIMIT ${MAX_SESSIONS}`,
      )
      .all() as OpencodeSessionRow[]
    const messageStates = readOpencodeMessageStates(db)
    const snapshots: OpencodeSessionSnapshot[] = []
    for (const row of rows) {
      const sessionId = typeof row.id === 'string' ? row.id : ''
      const cwd = typeof row.directory === 'string' ? row.directory : ''
      if (!sessionId || !cwd) continue
      // session_v2 only bumps at turn boundaries; message rows stream during a
      // turn, so liveness must consider both clocks.
      const state = messageStates.get(sessionId)
      const rowMs = toMs(row.time_updated ?? row.time_created)
      const mtimeMs = Math.max(rowMs, state?.activityAt ?? 0)
      if (mtimeMs <= 0) continue
      // OpenCode stores either a plain model name or a JSON descriptor
      // (`{"id":"mimo-v2.6-pro","providerID":"xiaomi-token-plan-cn"}`).
      snapshots.push({
        sessionId,
        cwd,
        mtimeMs,
        sourcePath,
        model: toModelId(row.model),
        modelObservedAt: mtimeMs,
        token: toToken(row, state?.contextTokens),
      })
    }
    return snapshots
  } finally {
    db.close()
  }
}

/**
 * Locates the newest session table present in the database.
 *
 * @param db Opened read-only database handle.
 * @returns Table name, or `undefined` when neither generation exists.
 */
function findSessionTable(db: Database.Database): string | undefined {
  const has = (name: string): boolean =>
    Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name))
  if (has('session_v2')) return 'session_v2'
  if (has('session')) return 'session'
  return undefined
}

/**
 * Normalizes schema-generation dependent timestamps to epoch milliseconds.
 * @param value Stored timestamp (epoch seconds or milliseconds).
 * @returns Epoch milliseconds, or 0 when the value is unusable.
 */
function toMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

/**
 * Coerces a stored token column to a positive count.
 * @param value Stored column value.
 * @returns Rounded count, or `undefined` when absent or zero.
 */
function toCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined
}

/**
 * Finds each session's latest message activity and last completed request tokens.
 *
 * @param db Opened read-only database handle.
 * @returns Map of session id to its latest message state.
 */
function readOpencodeMessageStates(db: Database.Database): Map<string, OpencodeMessageState> {
  const states = new Map<string, OpencodeMessageState>()
  try {
    const rows = db
      .prepare(
        `SELECT session_id, data, COALESCE(time_updated, time_created) AS at ` +
          `FROM session_message WHERE type='assistant' ORDER BY time_updated DESC LIMIT ${MAX_MESSAGE_ROWS}`,
      )
      .all() as Array<{ session_id?: unknown; data?: unknown; at?: unknown }>
    for (const row of rows) {
      if (typeof row.session_id !== 'string') continue
      const at = toMs(row.at)
      let state = states.get(row.session_id)
      if (!state) {
        state = { activityAt: at }
        states.set(row.session_id, state)
      }
      if (at > state.activityAt) state.activityAt = at
      // Streaming rows lack tokens; keep scanning older rows until one has them.
      if (state.contextTokens || typeof row.data !== 'string') continue
      state.contextTokens = parseMessageContext(row.data)
    }
  } catch {
    // Older schemas may lack session_message; session rows alone still work.
  }
  return states
}

/**
 * Extracts the last request's context footprint from an assistant message.
 *
 * @param data Raw message data JSON.
 * @returns Fresh input and cache token counts, or `undefined` without usage.
 */
function parseMessageContext(data: string): { input: number; cached: number } | undefined {
  try {
    const parsed: unknown = JSON.parse(data)
    if (!parsed || typeof parsed !== 'object') return undefined
    const tokens = (parsed as { tokens?: unknown }).tokens
    if (!tokens || typeof tokens !== 'object') return undefined
    const t = tokens as { input?: unknown; cache?: { read?: unknown; write?: unknown } }
    const input = typeof t.input === 'number' && Number.isFinite(t.input) ? t.input : 0
    const read = typeof t.cache?.read === 'number' ? t.cache.read : 0
    const write = typeof t.cache?.write === 'number' ? t.cache.write : 0
    const cached = read + write
    if (input <= 0 && cached <= 0) return undefined
    return { input, cached }
  } catch {
    return undefined
  }
}

/**
 * Extracts a display model id from OpenCode's model column.
 *
 * OpenCode stores either a plain model name or a JSON descriptor
 * (`{"id":"mimo-v2.6-pro","providerID":"xiaomi-token-plan-cn"}`).
 *
 * @param value Stored model column value.
 * @returns Model id suitable for display, or `undefined` when absent.
 */
function toModelId(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  if (!value.startsWith('{')) return value
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as { id?: unknown }).id
      if (typeof id === 'string' && id) return id
    }
  } catch {
    // Fall through to the raw string below.
  }
  return value
}

/**
 * Maps OpenCode's cumulative session token columns to a {@link TokenPayload}.
 * @param row One session row.
 * @param context Last request's context footprint, when a completed message exists.
 * @returns Token payload, or `undefined` when the session has no usage yet.
 */
function toToken(
  row: OpencodeSessionRow,
  context?: { input: number; cached: number },
): TokenPayload | undefined {
  const input = toCount(row.tokens_input)
  const output = toCount(row.tokens_output)
  const reasoningOutput = toCount(row.tokens_reasoning)
  const cachedInput = (toCount(row.tokens_cache_read) ?? 0) + (toCount(row.tokens_cache_write) ?? 0)
  const cached = cachedInput > 0 ? cachedInput : undefined
  if (
    input == null &&
    output == null &&
    cached == null &&
    reasoningOutput == null &&
    context == null
  ) {
    return undefined
  }
  const total = (input ?? 0) + (output ?? 0) + (cached ?? 0)
  const contextUsed = context ? context.input + context.cached : undefined
  return {
    input,
    output,
    reasoningOutput,
    cachedInput: cached,
    total: total > 0 ? total : undefined,
    contextWindow: contextUsed != null ? DEFAULT_CONTEXT_WINDOW : undefined,
    contextUsedPercent:
      contextUsed != null ? Math.min(100, (contextUsed / DEFAULT_CONTEXT_WINDOW) * 100) : undefined,
    accuracy: 'exact',
  }
}

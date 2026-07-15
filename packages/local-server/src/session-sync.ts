/**
 * 主动扫描本机 CLI 会话目录，把正在跑 / 最近活跃的项目同步进 StatusHub。
 *
 * 打开 CodePulse 时若任务已在 CLI 后台运行，不一定马上有 hook；
 * 本模块在启动 5s 内连扫 + 稳态轮询，直接读本地文件补齐项目/上下文/额度。
 *
 * @module local-server/session-sync
 */
import { readdir, readFile, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AgentEvent, TokenPayload } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import {
  asRecord,
  pickNumber,
  pickRateLimitId,
  pickRateLimitName,
  pickRateLimits,
} from '@codepulse/adapters'
import { readCodexQuotaTokenFromFile } from './quota-watcher.js'

const MAX_CODEX_FILES = 60
const MAX_GROK_SESSIONS = 40
const CODEX_META_HEAD = 128 * 1024
/** 最近修改的会话视为仍可能相关。 */
const RECENT_MS = 6 * 60 * 60_000
/** 启动后快速连扫，保证约 5s 内多轮补全。 */
const BOOT_OFFSETS_MS = [0, 800, 2_000, 4_000] as const
/** 稳态轮询：后台任务进度/额度持续刷新。 */
const STEADY_INTERVAL_MS = 12_000

export interface SessionSyncOptions {
  hub: StatusHub
  codexHome?: string
  grokHome?: string
  now?: () => number
}

export class SessionSyncService {
  private readonly hub: StatusHub
  private readonly codexHome: string
  private readonly grokHome: string
  private readonly now: () => number
  private timers: NodeJS.Timeout[] = []
  private steady?: NodeJS.Timeout
  private running = false
  private stopped = false

  constructor(options: SessionSyncOptions) {
    this.hub = options.hub
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.grokHome = options.grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
    this.now = options.now ?? Date.now
  }

  /** 启动：立即同步 + 5s 内连扫 + 稳态轮询。 */
  start(): void {
    this.stopped = false
    for (const offset of BOOT_OFFSETS_MS) {
      const t = setTimeout(() => {
        void this.syncOnce()
      }, offset)
      t.unref?.()
      this.timers.push(t)
    }
    this.steady = setInterval(() => {
      void this.syncOnce()
    }, STEADY_INTERVAL_MS)
    this.steady.unref?.()
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.steady) clearInterval(this.steady)
    this.steady = undefined
  }

  /** 立即再扫一轮（窗口聚焦时调用）。 */
  async syncNow(): Promise<void> {
    await this.syncOnce()
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped || this.running) return
    this.running = true
    try {
      await Promise.all([this.syncCodex(), this.syncGrok()])
    } catch (err) {
      console.error('[codepulse] session sync failed', err)
    } finally {
      this.running = false
    }
  }

  private async syncCodex(): Promise<void> {
    const files = await listRecentCodexRollouts(join(this.codexHome, 'sessions'))
    const now = this.now()
    for (const file of files) {
      try {
        if (now - file.mtimeMs > RECENT_MS) continue
        const meta = await readCodexRolloutMeta(file.path)
        const cwd = meta.cwd
        if (!cwd) continue

        const token = await readCodexQuotaTokenFromFile(file.path)
        const sessionId = meta.sessionId ?? sessionIdFromRolloutName(file.path)

        const event: AgentEvent = {
          id: `session-sync:codex:${sessionId}:${now}`,
          source: 'codex',
          eventType: 'token_snapshot',
          externalSessionId: sessionId,
          cwd,
          workspacePath: cwd,
          model: meta.model,
          token: token ?? { accuracy: 'unknown' },
          tokenSourcePath: file.path,
          // Use wall clock so project ranks as recently synced, not ancient mtime-only.
          timestamp: now,
          internal: { sessionSync: true },
        }
        this.hub.ingest(event)
      } catch {
        // Ignore single-file failures.
      }
    }
  }

  private async syncGrok(): Promise<void> {
    const now = this.now()
    const active = await readGrokActiveSessions(this.grokHome)
    const seen = new Set<string>()

    for (const row of active) {
      const key = `${row.sessionId}:${normalizePathKey(row.cwd)}`
      if (seen.has(key)) continue
      seen.add(key)
      await this.ingestGrokSession(row.sessionId, row.cwd, now)
    }

    const recent = await listRecentGrokSessions(join(this.grokHome, 'sessions'), now)
    for (const item of recent) {
      if (!item.cwd) continue
      const key = `${item.sessionId}:${normalizePathKey(item.cwd)}`
      if (seen.has(key)) continue
      seen.add(key)
      await this.ingestGrokSession(item.sessionId, item.cwd, now)
    }
  }

  private async ingestGrokSession(sessionId: string, cwd: string, now: number): Promise<void> {
    try {
      const usage = await readGrokSessionUsage(this.grokHome, sessionId, cwd)
      const token = grokUsageToToken(usage)
      this.hub.ingest({
        id: `session-sync:grok:${sessionId}:${now}`,
        source: 'grok',
        eventType: 'token_snapshot',
        externalSessionId: sessionId,
        cwd,
        workspacePath: cwd,
        model: typeof usage.model === 'string' ? usage.model : undefined,
        token: token ?? { accuracy: 'unknown' },
        tokenSourcePath:
          typeof usage.usage_source_path === 'string' ? usage.usage_source_path : undefined,
        timestamp: now,
        internal: { sessionSync: true },
      })
    } catch {
      // ignore
    }
  }
}

// ─── Codex disk scan ─────────────────────────────────────────────────────────

interface RolloutFile {
  path: string
  mtimeMs: number
}

async function listRecentCodexRollouts(sessionsRoot: string): Promise<RolloutFile[]> {
  const out: RolloutFile[] = []
  await walkRollouts(sessionsRoot, out)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_CODEX_FILES)
}

async function walkRollouts(dir: string, out: RolloutFile[], depth = 0): Promise<void> {
  if (out.length >= MAX_CODEX_FILES * 2 || depth > 5) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkRollouts(full, out, depth + 1)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = await stat(full)
      out.push({ path: full, mtimeMs: info.mtimeMs })
    } catch {
      // ignore
    }
  }
}

async function readCodexRolloutMeta(
  file: string,
): Promise<{ cwd?: string; sessionId?: string; model?: string }> {
  const text = await readHead(file, CODEX_META_HEAD)
  let meta: { cwd?: string; sessionId?: string; model?: string } = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as {
        type?: string
        payload?: Record<string, unknown>
      }
      if (item?.type === 'session_meta' && item.payload) {
        const p = item.payload
        meta = {
          ...meta,
          cwd: stringVal(p.cwd) ?? meta.cwd,
          sessionId: stringVal(p.id) ?? stringVal(p.session_id) ?? meta.sessionId,
          model: stringVal(p.model) ?? meta.model,
        }
      }
      if (item?.type === 'turn_context' && item.payload) {
        const p = item.payload
        meta = {
          ...meta,
          cwd: stringVal(p.cwd) ?? meta.cwd,
          model: stringVal(p.model) ?? meta.model,
        }
      }
      if (meta.cwd && meta.sessionId) break
    } catch {
      continue
    }
  }
  if (!meta.sessionId) meta.sessionId = sessionIdFromRolloutName(file)
  return meta
}

function sessionIdFromRolloutName(file: string): string {
  const name = basename(file)
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m?.[1] ?? name.replace(/\.jsonl$/i, '')
}

// ─── Grok disk scan ──────────────────────────────────────────────────────────

async function readGrokActiveSessions(
  grokHome: string,
): Promise<Array<{ sessionId: string; cwd: string }>> {
  try {
    const raw = JSON.parse(await readFile(join(grokHome, 'active_sessions.json'), 'utf8')) as unknown
    if (!Array.isArray(raw)) return []
    const out: Array<{ sessionId: string; cwd: string }> = []
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const sessionId = stringVal(r.session_id) ?? stringVal(r.sessionId)
      const cwd = stringVal(r.cwd)
      if (sessionId && cwd) out.push({ sessionId, cwd })
    }
    return out
  } catch {
    return []
  }
}

async function listRecentGrokSessions(
  sessionsRoot: string,
  now: number,
): Promise<Array<{ sessionId: string; cwd?: string; mtimeMs: number }>> {
  const out: Array<{ sessionId: string; cwd?: string; mtimeMs: number }> = []
  await walkGrokSessions(sessionsRoot, out, 0, now)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_GROK_SESSIONS)
}

async function walkGrokSessions(
  dir: string,
  out: Array<{ sessionId: string; cwd?: string; mtimeMs: number }>,
  depth: number,
  now: number,
): Promise<void> {
  if (out.length >= MAX_GROK_SESSIONS * 2 || depth > 4) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  const hasSessionMarker = entries.some(
    (e) =>
      e.isFile() &&
      (e.name === 'summary.json' || e.name === 'signals.json' || e.name === 'updates.jsonl'),
  )
  if (hasSessionMarker) {
    let mtimeMs = 0
    for (const name of ['signals.json', 'updates.jsonl', 'summary.json']) {
      try {
        const s = await stat(join(dir, name))
        mtimeMs = Math.max(mtimeMs, s.mtimeMs)
      } catch {
        // next
      }
    }
    if (mtimeMs > 0 && now - mtimeMs <= RECENT_MS) {
      let cwd: string | undefined
      try {
        const summary = JSON.parse(await readFile(join(dir, 'summary.json'), 'utf8')) as {
          info?: { cwd?: string }
          cwd?: string
        }
        cwd = summary?.info?.cwd ?? summary?.cwd
      } catch {
        // ignore
      }
      out.push({ sessionId: basename(dir), cwd, mtimeMs })
    }
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await walkGrokSessions(join(dir, entry.name), out, depth + 1, now)
  }
}

async function readGrokSessionUsage(
  grokHome: string,
  sessionId: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const group = encodeURIComponent(cwd)
  const sessionDir = join(grokHome, 'sessions', group, sessionId)

  // 1) signals.json (post-turn complete)
  try {
    const signals = JSON.parse(await readFile(join(sessionDir, 'signals.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const contextTokensUsed = num(signals.contextTokensUsed)
    const contextWindowTokens = num(signals.contextWindowTokens)
    const contextWindowUsage = num(signals.contextWindowUsage)
    const model =
      stringVal(signals.primaryModelId) ??
      (Array.isArray(signals.modelsUsed) ? stringVal(signals.modelsUsed[0]) : undefined)
    const pct =
      contextWindowUsage ??
      (contextTokensUsed != null && contextWindowTokens
        ? Math.min(100, (contextTokensUsed / contextWindowTokens) * 100)
        : undefined)
    if (pct != null || contextTokensUsed != null) {
      return {
        model,
        context_window_size: contextWindowTokens,
        context_used_percent: pct,
        usage:
          contextTokensUsed != null
            ? { input_tokens: contextTokensUsed, total_tokens: contextTokensUsed }
            : undefined,
        usage_source_path: join(sessionDir, 'signals.json'),
      }
    }
  } catch {
    // try updates.jsonl
  }

  // 2) Active session: updates.jsonl last params._meta.totalTokens
  try {
    const text = await readTailFile(join(sessionDir, 'updates.jsonl'), 512 * 1024)
    const lines = text.trim().split(/\r?\n/)
    let totalTokens: number | undefined
    let model: string | undefined
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i] ?? '') as {
          params?: { _meta?: { totalTokens?: number }; model?: string; modelId?: string }
        }
        const meta = item?.params?._meta
        const t = num(meta?.totalTokens)
        if (t == null) continue
        totalTokens = t
        model = stringVal(item.params?.model) ?? stringVal(item.params?.modelId)
        break
      } catch {
        continue
      }
    }
    if (totalTokens == null) return {}

    let contextWindow = 500_000
    try {
      const cache = JSON.parse(await readFile(join(grokHome, 'models_cache.json'), 'utf8')) as {
        models?: Array<{ id?: string; context_window?: number }>
      }
      if (model && Array.isArray(cache.models)) {
        const hit = cache.models.find((m) => m.id === model)
        if (hit?.context_window) contextWindow = hit.context_window
      }
    } catch {
      // default window
    }

    const pct = Math.min(100, (totalTokens / contextWindow) * 100)
    let summaryModel = model
    try {
      const summary = JSON.parse(await readFile(join(sessionDir, 'summary.json'), 'utf8')) as {
        current_model_id?: string
      }
      summaryModel = summaryModel ?? stringVal(summary.current_model_id)
    } catch {
      // ignore
    }

    return {
      model: summaryModel,
      context_window_size: contextWindow,
      context_used_percent: pct,
      usage: { input_tokens: totalTokens, total_tokens: totalTokens },
      usage_source_path: join(sessionDir, 'updates.jsonl'),
    }
  } catch {
    return {}
  }
}

async function readTailFile(file: string, maxBytes: number): Promise<string> {
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

function grokUsageToToken(usage: Record<string, unknown>): TokenPayload | undefined {
  const pct = pickNumber(usage, 'context_used_percent', 'contextUsedPercent')
  const window = pickNumber(usage, 'context_window_size', 'contextWindowSize')
  const usageRec = asRecord(usage.usage)
  const contextRec = asRecord(usage.context_usage ?? usage.contextUsage)
  const input =
    pickNumber(usageRec ?? {}, 'input_tokens', 'inputTokens') ??
    pickNumber(contextRec ?? {}, 'input_tokens', 'inputTokens')
  const total =
    pickNumber(usageRec ?? {}, 'total_tokens', 'totalTokens') ??
    pickNumber(contextRec ?? {}, 'total_tokens', 'totalTokens')
  const rateLimits = pickRateLimits(usage)
  const rateLimitId = pickRateLimitId(usage)
  const rateLimitName = pickRateLimitName(usage)
  if (pct == null && window == null && input == null && total == null && !rateLimits) {
    return undefined
  }
  return {
    input,
    total,
    contextUsedPercent: pct,
    contextWindow: window,
    rateLimits,
    rateLimitId,
    rateLimitName,
    accuracy: 'estimated',
  }
}

// ─── utils ───────────────────────────────────────────────────────────────────

async function readHead(file: string, maxBytes: number): Promise<string> {
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

function stringVal(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

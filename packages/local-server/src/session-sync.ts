/**
 * 主动扫描本机 **当前打开的** CLI 会话，把项目/上下文/额度灌进 StatusHub。
 *
 * 只同步「用户正从这个项目开着 CLI」的槽位，不把磁盘上沉寂/历史项目拉出来：
 * - Grok：仅 `active_sessions.json` 且进程仍存活
 * - Codex：仅近期仍在写入的 rollout（CLI 开着才会持续写盘），且本机有 codex 进程
 * - Claude：仅 `~/.claude/sessions/{pid}.json` 且 pid 仍存活；上下文从 projects transcript 尾部读取
 *
 * 其它：启动 await 首扫、稳态轮询、目录监听、指纹增量 ingest。
 *
 * @module local-server/session-sync
 */
import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { TokenPayload } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import {
  asRecord,
  pickNumber,
  pickRateLimitId,
  pickRateLimitName,
  pickRateLimits,
} from '@codepulse/adapters'
import { readCodexQuotaTokenFromFile } from './quota-watcher.js'

const MAX_CODEX_FILES = 80
const CODEX_META_HEAD = 512 * 1024
const CODEX_TAIL = 2 * 1024 * 1024
/**
 * Codex 无 active_sessions：用 rollout mtime 近似「CLI 仍开着」。
 * 等额度重置时 CLI 可能数小时不写盘，窗口需明显宽于 30 分钟。
 * 仍要求本机有 codex 进程，避免把历史沉寂项目拉出来。
 */
const CODEX_LIVE_MS = 12 * 60 * 60_000
/** 进程在线但完全无近期写入时，仍取最近一份 rollout 做额度壳（不扫 48h 多项目）。 */
const CODEX_QUOTA_FALLBACK_MS = 48 * 60 * 60_000
const BOOT_OFFSETS_MS = [0, 800, 2_000, 4_000, 6_000] as const
const STEADY_INTERVAL_MS = 8_000
const WATCH_DEBOUNCE_MS = 600
/** 指纹未变时仍定期刷新 lastEventAt，避免 IDLE 槽位被 hub 5min 回收。 */
const KEEPALIVE_MS = 2 * 60_000
const GROK_BILLING_MSG = 'billing: fetched credits config'
const CLAUDE_TRANSCRIPT_TAIL = 512 * 1024
const DEFAULT_CLAUDE_CONTEXT_WINDOW = pickNumberEnv(process.env.CODEPULSE_CONTEXT_WINDOW) ?? 200_000

export interface SessionSyncOptions {
  hub: StatusHub
  codexHome?: string
  grokHome?: string
  claudeHome?: string
  now?: () => number
  /** 测试时可关闭文件监听 */
  disableWatch?: boolean
  /** 测试注入：是否视为本机有 Codex CLI 进程 */
  codexProcessAlive?: () => boolean | Promise<boolean>
  /** 测试注入：Grok/Claude session 的 pid 是否存活 */
  isPidAlive?: (pid: number) => boolean
}

type SyncSource = 'codex' | 'grok' | 'claude_code'

export class SessionSyncService {
  private readonly hub: StatusHub
  private readonly codexHome: string
  private readonly grokHome: string
  private readonly claudeHome: string
  private readonly now: () => number
  private readonly disableWatch: boolean
  private readonly codexProcessAlive: () => boolean | Promise<boolean>
  private readonly pidAlive: (pid: number) => boolean
  private timers: NodeJS.Timeout[] = []
  private steady?: NodeJS.Timeout
  private watchDebounce?: NodeJS.Timeout
  private watchers: FSWatcher[] = []
  private running = false
  private stopped = false
  private lastLogAt = 0
  /** sessionKey → fingerprint of last ingested payload */
  private fingerprints = new Map<string, string>()
  /** sessionKey → last keep-alive emit time */
  private keepAliveAt = new Map<string, number>()
  private firstSync: Promise<void>
  private resolveFirstSync!: () => void
  private firstSyncDone = false

  constructor(options: SessionSyncOptions) {
    this.hub = options.hub
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
    this.grokHome = options.grokHome ?? process.env.GROK_HOME ?? join(homedir(), '.grok')
    this.claudeHome = options.claudeHome ?? process.env.CLAUDE_HOME ?? join(homedir(), '.claude')
    this.now = options.now ?? Date.now
    this.disableWatch = options.disableWatch ?? false
    this.codexProcessAlive = options.codexProcessAlive ?? (() => isCliProcessAlive('codex'))
    this.pidAlive = options.isPidAlive ?? isPidAlive
    this.firstSync = new Promise<void>((resolve) => {
      this.resolveFirstSync = resolve
    })
  }

  /**
   * 启动主动同步：立刻首扫 + 启动期补扫 + 稳态轮询 + 目录监听。
   * 返回值在**首扫完成**后 resolve，便于 bootstrap 等 hub 有数据再开窗。
   */
  start(): Promise<void> {
    this.stopped = false
    void this.syncOnce('boot').finally(() => {
      if (!this.firstSyncDone) {
        this.firstSyncDone = true
        this.resolveFirstSync()
      }
    })

    for (const offset of BOOT_OFFSETS_MS) {
      if (offset === 0) continue
      const t = setTimeout(() => {
        void this.syncOnce('boot')
      }, offset)
      t.unref?.()
      this.timers.push(t)
    }

    this.steady = setInterval(() => {
      void this.syncOnce('steady')
    }, STEADY_INTERVAL_MS)
    this.steady.unref?.()

    if (!this.disableWatch) this.startWatchers()
    return this.firstSync
  }

  /** 等待首扫结束（若 start 未调用则立即返回）。 */
  whenReady(): Promise<void> {
    return this.firstSync
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.steady) clearInterval(this.steady)
    this.steady = undefined
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    this.watchDebounce = undefined
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    this.watchers = []
    if (!this.firstSyncDone) {
      this.firstSyncDone = true
      this.resolveFirstSync()
    }
  }

  async syncNow(): Promise<void> {
    await this.syncOnce('manual')
  }

  private startWatchers(): void {
    const roots = [
      join(this.codexHome, 'sessions'),
      join(this.grokHome, 'sessions'),
      join(this.grokHome, 'active_sessions.json'),
      join(this.grokHome, 'logs'),
      join(this.claudeHome, 'sessions'),
      join(this.claudeHome, 'projects'),
    ]
    for (const root of roots) {
      try {
        const w = watch(root, { recursive: true }, () => this.scheduleWatchSync())
        w.on('error', () => {
          // Directory may not exist yet; ignore.
        })
        this.watchers.push(w)
      } catch {
        // Missing path — polling still covers it.
      }
    }
  }

  private scheduleWatchSync(): void {
    if (this.stopped) return
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined
      void this.syncOnce('watch')
    }, WATCH_DEBOUNCE_MS)
    this.watchDebounce.unref?.()
  }

  private async syncOnce(reason: string): Promise<void> {
    if (this.stopped) return
    // Serialize scans so boot/watch/manual do not interleave.
    while (this.running) {
      await sleep(40)
      if (this.stopped) return
    }
    this.running = true
    const t0 = this.now()
    try {
      const [codexCount, grokCount, claudeCount] = await Promise.all([
        this.syncCodex(),
        this.syncGrok(),
        this.syncClaude(),
      ])
      const elapsed = this.now() - t0
      if (reason !== 'steady' || this.now() - this.lastLogAt > 60_000) {
        console.log(
          `[codepulse] session-sync (${reason}): codex=${codexCount} grok=${grokCount} claude=${claudeCount} in ${elapsed}ms`,
        )
        this.lastLogAt = this.now()
      }
    } catch (err) {
      console.error('[codepulse] session sync failed', err)
    } finally {
      this.running = false
    }
  }

  private async syncCodex(): Promise<number> {
    // No running Codex CLI → never resurrect historical projects from disk.
    if (!(await this.codexProcessAlive())) return 0

    const sessionsRoot = join(this.codexHome, 'sessions')
    let files = await listLiveCodexRollouts(sessionsRoot, this.now(), CODEX_LIVE_MS)
    // Waiting for weekly reset: CLI process is up but may not have written for hours.
    // Fall back to the single freshest rollout (quota shell), not a multi-project sweep.
    if (files.length === 0) {
      const fallback = await listLiveCodexRollouts(
        sessionsRoot,
        this.now(),
        CODEX_QUOTA_FALLBACK_MS,
      )
      if (fallback[0]) files = [fallback[0]]
    }
    const now = this.now()
    let count = 0
    // Dedupe by workspace: keep the freshest *live* file per cwd.
    const byCwd = new Map<string, { file: RolloutFile; meta: CodexMeta; token?: TokenPayload }>()

    for (const file of files) {
      try {
        const meta = await readCodexRolloutMeta(file.path)
        let cwd = meta.cwd
        if (!cwd) cwd = await findCwdInTail(file.path)
        if (!cwd) continue

        const token =
          (await readCodexQuotaTokenFromFile(file.path)) ??
          (await readCodexTokenFallback(file.path))

        const key = normalizePathKey(cwd)
        const prev = byCwd.get(key)
        if (!prev || file.mtimeMs >= prev.file.mtimeMs) {
          byCwd.set(key, { file, meta: { ...meta, cwd }, token })
        }
      } catch (err) {
        console.error('[codepulse] session-sync codex file failed', file.path, err)
      }
    }

    for (const { file, meta, token } of byCwd.values()) {
      const sessionId = meta.sessionId ?? sessionIdFromRolloutName(file.path)
      const cwd = meta.cwd!
      const payloadToken = token ?? { accuracy: 'unknown' as const, contextWindow: 256_000 }
      const mapKey = `codex:${sessionId}`
      if (
        this.shouldSkipUnchanged(
          mapKey,
          'codex',
          sessionId,
          cwd,
          file.mtimeMs,
          payloadToken,
          meta.model,
        )
      ) {
        continue
      }

      this.ingestHydrate({
        source: 'codex',
        sessionId,
        cwd,
        model: meta.model,
        token: payloadToken,
        tokenSourcePath: file.path,
        now,
      })
      count += 1
    }
    return count
  }

  private async syncGrok(): Promise<number> {
    const now = this.now()
    const billing = await readGrokBillingQuota(this.grokHome)
    // Only sessions the user currently has open (active_sessions + live pid).
    // Do NOT walk historical ~/.grok/sessions — that resurrects idle projects.
    const active = await readGrokActiveSessions(this.grokHome)
    const byCwd = new Map<string, { sessionId: string; cwd: string; mtimeMs: number }>()

    for (const row of active) {
      if (row.pid != null && !this.pidAlive(row.pid)) continue
      const key = normalizePathKey(row.cwd)
      // Active list is authoritative; last write wins if duplicates.
      byCwd.set(key, { sessionId: row.sessionId, cwd: row.cwd, mtimeMs: now })
    }

    let count = 0
    for (const row of byCwd.values()) {
      if (await this.ingestGrokSession(row.sessionId, row.cwd, now, billing, row.mtimeMs)) {
        count += 1
      }
    }

    // No open sessions but billing available → quota-only shell (no project row).
    if (count === 0 && billing.token?.rateLimits) {
      const mapKey = 'grok:quota-only'
      const fp = fingerprint('grok', 'quota-only', '', 0, billing.token, undefined)
      if (this.fingerprints.get(mapKey) !== fp) {
        this.fingerprints.set(mapKey, fp)
        this.hub.ingest({
          id: `session-sync:grok:quota:${now}`,
          source: 'grok',
          eventType: 'token_snapshot',
          token: billing.token,
          tokenSourcePath: billing.sourcePath,
          timestamp: now,
          internal: { sessionSync: true, quotaRefresh: true },
        })
        count += 1
      }
    }
    return count
  }

  private async ingestGrokSession(
    sessionId: string,
    cwd: string,
    now: number,
    billing: { token?: TokenPayload; sourcePath?: string },
    mtimeMs: number,
  ): Promise<boolean> {
    try {
      const usage = await readGrokSessionUsage(this.grokHome, sessionId, cwd)
      const contextToken = grokUsageToToken(usage)
      const token = mergeGrokToken(contextToken, billing.token)
      const model = typeof usage.model === 'string' ? usage.model : undefined
      const sourcePath =
        typeof usage.usage_source_path === 'string' ? usage.usage_source_path : billing.sourcePath

      const payloadToken = token ?? { accuracy: 'unknown' as const }
      const mapKey = `grok:${sessionId}`
      if (this.shouldSkipUnchanged(mapKey, 'grok', sessionId, cwd, mtimeMs, payloadToken, model)) {
        return false
      }

      this.ingestHydrate({
        source: 'grok',
        sessionId,
        cwd,
        model,
        token: payloadToken,
        tokenSourcePath: sourcePath,
        now,
      })
      return true
    } catch (err) {
      console.error('[codepulse] session-sync grok failed', sessionId, err)
      return false
    }
  }

  /**
   * Claude Code：`~/.claude/sessions/{pid}.json` 列出当前交互会话。
   * 仅同步 pid 仍存活的条目；上下文从 projects transcript 尾部读取。
   */
  private async syncClaude(): Promise<number> {
    const now = this.now()
    const active = await readClaudeActiveSessions(this.claudeHome)
    let count = 0
    const byCwd = new Map<
      string,
      { sessionId: string; cwd: string; updatedAt: number; pid?: number }
    >()

    for (const row of active) {
      if (row.pid != null && !this.pidAlive(row.pid)) continue
      // Prefer freshest session per project root.
      const key = normalizePathKey(row.cwd)
      const prev = byCwd.get(key)
      if (!prev || row.updatedAt >= prev.updatedAt) {
        byCwd.set(key, row)
      }
    }

    for (const row of byCwd.values()) {
      if (await this.ingestClaudeSession(row.sessionId, row.cwd, now, row.updatedAt)) {
        count += 1
      }
    }
    return count
  }

  private async ingestClaudeSession(
    sessionId: string,
    cwd: string,
    now: number,
    updatedAt: number,
  ): Promise<boolean> {
    try {
      const transcript = await findClaudeTranscript(this.claudeHome, sessionId)
      const usage = transcript ? await readClaudeTranscriptUsage(transcript) : undefined
      const token = claudeUsageToToken(usage) ?? { accuracy: 'unknown' as const }
      const model = usage?.model
      const mapKey = `claude_code:${sessionId}`
      if (
        this.shouldSkipUnchanged(mapKey, 'claude_code', sessionId, cwd, updatedAt, token, model)
      ) {
        return false
      }

      this.ingestHydrate({
        source: 'claude_code',
        sessionId,
        cwd,
        model,
        token,
        tokenSourcePath: transcript,
        now,
      })
      return true
    } catch (err) {
      console.error('[codepulse] session-sync claude failed', sessionId, err)
      return false
    }
  }

  /**
   * Skip only when data is unchanged, the hub still has the slot, and a recent
   * keep-alive already refreshed lastEventAt. Otherwise re-ingest.
   */
  private shouldSkipUnchanged(
    mapKey: string,
    source: SyncSource,
    sessionId: string,
    cwd: string,
    mtimeMs: number,
    token: TokenPayload,
    model: string | undefined,
  ): boolean {
    const fp = fingerprint(source, sessionId, cwd, mtimeMs, token, model)
    const prev = this.fingerprints.get(mapKey)
    const inHub = this.hubHasSession(source, sessionId)
    if (prev !== fp || !inHub) {
      this.fingerprints.set(mapKey, fp)
      return false
    }
    const lastKa = this.keepAliveAt.get(mapKey) ?? 0
    if (this.now() - lastKa >= KEEPALIVE_MS) {
      this.fingerprints.set(mapKey, fp)
      return false
    }
    return true
  }

  private hubHasSession(source: SyncSource, sessionId: string): boolean {
    return this.hub
      .snapshot()
      .agents.some((a) => a.agentType === source && a.externalSessionId === sessionId)
  }

  /**
   * First sighting: session_start + token_snapshot.
   * Later: token_snapshot only (avoids markContextStale on every poll).
   */
  private ingestHydrate(args: {
    source: SyncSource
    sessionId: string
    cwd: string
    model?: string
    token: TokenPayload
    tokenSourcePath?: string
    now: number
  }): void {
    const startKey = `started:${args.source}:${args.sessionId}`
    const alreadyStarted = this.fingerprints.has(startKey)

    if (!alreadyStarted) {
      this.fingerprints.set(startKey, '1')
      this.hub.ingest({
        id: `session-sync:${args.source}:start:${args.sessionId}:${args.now}`,
        source: args.source,
        eventType: 'session_start',
        externalSessionId: args.sessionId,
        cwd: args.cwd,
        workspacePath: args.cwd,
        model: args.model,
        timestamp: args.now,
        internal: { sessionSync: true },
      })
    }

    this.hub.ingest({
      id: `session-sync:${args.source}:token:${args.sessionId}:${args.now}`,
      source: args.source,
      eventType: 'token_snapshot',
      externalSessionId: args.sessionId,
      cwd: args.cwd,
      workspacePath: args.cwd,
      model: args.model,
      token: args.token,
      tokenSourcePath: args.tokenSourcePath,
      timestamp: args.now,
      internal: { sessionSync: true },
    })
    this.keepAliveAt.set(`${args.source}:${args.sessionId}`, args.now)
  }
}

// ─── Codex ───────────────────────────────────────────────────────────────────

interface RolloutFile {
  path: string
  mtimeMs: number
}

interface CodexMeta {
  cwd?: string
  sessionId?: string
  model?: string
}

/** Rollouts with mtime within `maxAgeMs` (newest first). */
async function listLiveCodexRollouts(
  sessionsRoot: string,
  now: number,
  maxAgeMs: number,
): Promise<RolloutFile[]> {
  const out: RolloutFile[] = []
  await walkRollouts(sessionsRoot, out, 0, now, maxAgeMs)
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out.slice(0, MAX_CODEX_FILES)
}

async function walkRollouts(
  dir: string,
  out: RolloutFile[],
  depth: number,
  now: number,
  maxAgeMs: number,
): Promise<void> {
  if (out.length >= MAX_CODEX_FILES * 3 || depth > 6) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkRollouts(full, out, depth + 1, now, maxAgeMs)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = await stat(full)
      if (now - info.mtimeMs > maxAgeMs) continue
      out.push({ path: full, mtimeMs: info.mtimeMs })
    } catch {
      // ignore locked/missing
    }
  }
}

async function readCodexRolloutMeta(file: string): Promise<CodexMeta> {
  const text = await readHead(file, CODEX_META_HEAD)
  let meta: CodexMeta = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const item = JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }
      const p = item.payload
      if (!p) continue
      if (item.type === 'session_meta' || item.type === 'turn_context') {
        meta = {
          ...meta,
          cwd: stringVal(p.cwd) ?? meta.cwd,
          sessionId:
            stringVal(p.id) ?? stringVal(p.session_id) ?? stringVal(p.sessionId) ?? meta.sessionId,
          model: stringVal(p.model) ?? meta.model,
        }
      }
    } catch {
      // Truncated huge first line — try regex extraction.
      const partial = extractMetaFromPartialLine(line)
      if (partial.cwd || partial.sessionId || partial.model) {
        meta = { ...meta, ...partial }
      }
      continue
    }
  }
  if (!meta.sessionId) meta.sessionId = sessionIdFromRolloutName(file)
  if (!meta.cwd) {
    const partial = extractMetaFromPartialLine(text)
    if (partial.cwd) meta.cwd = partial.cwd
    if (partial.sessionId && !meta.sessionId) meta.sessionId = partial.sessionId
    if (partial.model && !meta.model) meta.model = partial.model
  }
  return meta
}

/** Recover cwd/session id when session_meta JSON is truncated by head limit. */
function extractMetaFromPartialLine(text: string): CodexMeta {
  const cwd =
    text.match(/"cwd"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1] ??
    text.match(/"cwd"\s*:\s*'((?:\\.|[^'\\])*)'/)?.[1]
  const sessionId =
    text.match(
      /"id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
    )?.[1] ??
    text.match(
      /"session_id"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i,
    )?.[1]
  const model = text.match(/"model"\s*:\s*"((?:\\.|[^"\\])*)"/)?.[1]
  return {
    cwd: cwd ? unescapeJsonString(cwd) : undefined,
    sessionId: sessionId ?? undefined,
    model: model ? unescapeJsonString(model) : undefined,
  }
}

function unescapeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replace(/\\(.)/g, '$1')
  }
}

async function findCwdInTail(file: string): Promise<string | undefined> {
  try {
    const text = await readTailFile(file, 256 * 1024)
    const lines = text.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const item = JSON.parse(lines[i] ?? '') as {
          type?: string
          payload?: { cwd?: string }
        }
        if (
          (item.type === 'turn_context' || item.type === 'session_meta') &&
          stringVal(item.payload?.cwd)
        ) {
          return stringVal(item.payload?.cwd)
        }
      } catch {
        const partial = extractMetaFromPartialLine(lines[i] ?? '')
        if (partial.cwd) return partial.cwd
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

/** Fallback when quota reader returns nothing — still extract last_token context. */
async function readCodexTokenFallback(file: string): Promise<TokenPayload | undefined> {
  try {
    const text = await readTailFile(file, CODEX_TAIL)
    const lines = text.trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      let item: { type?: string; payload?: Record<string, unknown> }
      try {
        item = JSON.parse(lines[i] ?? '')
      } catch {
        continue
      }
      if (item?.type !== 'event_msg') continue
      const payload = item.payload
      if (!payload || payload.type !== 'token_count') continue
      const info = asRecord(payload.info) ?? {}
      const last = asRecord(info.last_token_usage)
      const total = asRecord(info.total_token_usage)
      const window = num(info.model_context_window) ?? num(payload.model_context_window) ?? 256_000
      const input = last ? num(last.input_tokens) : undefined
      const pct = input != null && window > 0 ? Math.min(100, (input / window) * 100) : undefined
      const rateLimits = pickRateLimits(payload)
      return {
        input: input ?? num(total?.input_tokens),
        total: num(total?.total_tokens) ?? num(last?.total_tokens),
        contextUsedPercent: pct,
        contextWindow: window,
        rateLimits,
        rateLimitId: pickRateLimitId(payload),
        rateLimitName: pickRateLimitName(payload),
        accuracy: 'estimated',
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

function sessionIdFromRolloutName(file: string): string {
  const name = basename(file)
  const m = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
  return m?.[1] ?? name.replace(/\.jsonl$/i, '')
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

interface ClaudeActiveSession {
  sessionId: string
  cwd: string
  pid?: number
  updatedAt: number
}

/**
 * Claude Code writes one `{pid}.json` per interactive process under `~/.claude/sessions`.
 * Fields: pid, sessionId, cwd, status, updatedAt, …
 */
async function readClaudeActiveSessions(claudeHome: string): Promise<ClaudeActiveSession[]> {
  const root = join(claudeHome, 'sessions')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const out: ClaudeActiveSession[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const raw = JSON.parse(await readFile(join(root, name), 'utf8')) as Record<string, unknown>
      const sessionId = stringVal(raw.sessionId) ?? stringVal(raw.session_id)
      const cwd = stringVal(raw.cwd)
      if (!sessionId || !cwd) continue
      const pid = num(raw.pid) ?? num(basename(name).replace(/\.json$/i, ''))
      const updatedAt = num(raw.updatedAt) ?? num(raw.statusUpdatedAt) ?? 0
      out.push({ sessionId, cwd, pid, updatedAt })
    } catch {
      // ignore corrupt session files
    }
  }
  return out
}

/** Locate session transcript under claudeHome/projects by session id. */
async function findClaudeTranscript(
  claudeHome: string,
  sessionId: string,
): Promise<string | undefined> {
  const projectsRoot = join(claudeHome, 'projects')
  const target = `${sessionId}.jsonl`
  return walkFindFile(projectsRoot, target, 0)
}

async function walkFindFile(
  dir: string,
  fileName: string,
  depth: number,
): Promise<string | undefined> {
  if (depth > 4) return undefined
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name === fileName) return full
    if (entry.isDirectory()) {
      const hit = await walkFindFile(full, fileName, depth + 1)
      if (hit) return hit
    }
  }
  return undefined
}

interface ClaudeTranscriptUsage {
  model?: string
  input?: number
  output?: number
  total?: number
  cachedInput?: number
  contextUsedPercent?: number
  contextWindow?: number
}

async function readClaudeTranscriptUsage(
  transcriptPath: string,
): Promise<ClaudeTranscriptUsage | undefined> {
  try {
    const text = await readTailFile(transcriptPath, CLAUDE_TRANSCRIPT_TAIL)
    const lines = text.trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      let item: {
        type?: string
        message?: { usage?: Record<string, unknown>; model?: string }
        usage?: Record<string, unknown>
        model?: string
      }
      try {
        item = JSON.parse(lines[i] ?? '')
      } catch {
        continue
      }
      const usage = asRecord(item.message?.usage) ?? asRecord(item.usage)
      if (!usage) continue
      const inputTokens = num(usage.input_tokens)
      if (inputTokens == null && num(usage.cache_read_input_tokens) == null) continue

      const cacheRead = num(usage.cache_read_input_tokens) ?? 0
      const cacheCreate = num(usage.cache_creation_input_tokens) ?? 0
      const freshInput = inputTokens ?? 0
      // Current context footprint ≈ new input + cache read + cache write (statusline formula).
      const contextInput = freshInput + cacheRead + cacheCreate
      const output = num(usage.output_tokens)
      const model = stringVal(item.message?.model) ?? stringVal(item.model)
      // Prefer 1M window when context clearly exceeds classic 200k.
      const contextWindow =
        contextInput > DEFAULT_CLAUDE_CONTEXT_WINDOW
          ? Math.max(1_000_000, DEFAULT_CLAUDE_CONTEXT_WINDOW)
          : DEFAULT_CLAUDE_CONTEXT_WINDOW
      const contextUsedPercent =
        contextWindow > 0 ? Math.min(100, (contextInput / contextWindow) * 100) : undefined

      return {
        model,
        input: contextInput,
        output,
        total: output != null ? contextInput + output : contextInput,
        cachedInput: cacheRead + cacheCreate,
        contextUsedPercent,
        contextWindow,
      }
    }
  } catch {
    // ignore
  }
  return undefined
}

function claudeUsageToToken(usage: ClaudeTranscriptUsage | undefined): TokenPayload | undefined {
  if (!usage) return undefined
  if (
    usage.contextUsedPercent == null &&
    usage.input == null &&
    usage.output == null &&
    usage.contextWindow == null
  ) {
    return undefined
  }
  return {
    input: usage.input,
    output: usage.output,
    total: usage.total,
    cachedInput: usage.cachedInput,
    contextUsedPercent: usage.contextUsedPercent,
    contextWindow: usage.contextWindow,
    accuracy: 'estimated',
  }
}

function pickNumberEnv(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined
  const n = Number(value.trim())
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// ─── Grok ────────────────────────────────────────────────────────────────────

async function readGrokActiveSessions(
  grokHome: string,
): Promise<Array<{ sessionId: string; cwd: string; pid?: number }>> {
  try {
    const raw = JSON.parse(
      await readFile(join(grokHome, 'active_sessions.json'), 'utf8'),
    ) as unknown
    if (!Array.isArray(raw)) return []
    const out: Array<{ sessionId: string; cwd: string; pid?: number }> = []
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const sessionId = stringVal(r.session_id) ?? stringVal(r.sessionId)
      const cwd = stringVal(r.cwd)
      const pid = num(r.pid)
      if (sessionId && cwd) out.push({ sessionId, cwd, pid })
    }
    return out
  } catch {
    return []
  }
}

/** True if a process with this pid is still running. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // EPERM: process exists but we cannot signal it — still "alive".
    if (code === 'EPERM') return true
    return false
  }
}

/**
 * Best-effort: is any CLI binary of this family currently running?
 * Avoids resurfacing disk history after the user has closed every terminal.
 */
async function isCliProcessAlive(kind: 'codex' | 'grok'): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      // tasklist is always available; filter by image name.
      const image = kind === 'codex' ? 'codex.exe' : 'grok.exe'
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
        windowsHide: true,
        timeout: 3_000,
      })
      return stdout.toLowerCase().includes(image.toLowerCase())
    }
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execFileAsync = promisify(execFile)
    const { stdout } = await execFileAsync('pgrep', ['-x', kind], {
      timeout: 3_000,
    }).catch(() => ({ stdout: '' }))
    return String(stdout).trim().length > 0
  } catch {
    // If detection fails, fall through to mtime / active_sessions heuristics.
    return true
  }
}

async function readGrokSessionUsage(
  grokHome: string,
  sessionId: string,
  cwd: string,
): Promise<Record<string, unknown>> {
  const group = encodeURIComponent(cwd)
  const sessionDir = join(grokHome, 'sessions', group, sessionId)

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
    // try updates
  }

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
        const t = num(item?.params?._meta?.totalTokens)
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
      // default
    }

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
      context_used_percent: Math.min(100, (totalTokens / contextWindow) * 100),
      usage: { input_tokens: totalTokens, total_tokens: totalTokens },
      usage_source_path: join(sessionDir, 'updates.jsonl'),
    }
  } catch {
    return {}
  }
}

async function readGrokBillingQuota(
  grokHome: string,
): Promise<{ token?: TokenPayload; sourcePath?: string }> {
  const logPath = join(grokHome, 'logs', 'unified.jsonl')
  try {
    const text = await readTailFile(logPath, 1024 * 1024)
    if (!text) return {}
    const lines = text.trim().split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]
      if (!line || !line.includes(GROK_BILLING_MSG)) continue
      let item: {
        msg?: string
        ctx?: {
          config?: Record<string, unknown>
          subscriptionTier?: string
        }
      }
      try {
        item = JSON.parse(line)
      } catch {
        continue
      }
      if (item?.msg !== GROK_BILLING_MSG) continue
      const config = item.ctx?.config
      if (!config) continue

      const usedPercent = num(config.creditUsagePercent)
      const periodEnd =
        stringVal(config.billingPeriodEnd) ??
        stringVal(asRecord(config.currentPeriod)?.end) ??
        stringVal(asRecord(config.current_period)?.end)
      const resetsAt = periodEnd ? Math.floor(Date.parse(periodEnd) / 1000) : undefined
      const periodType =
        stringVal(asRecord(config.currentPeriod)?.type) ??
        stringVal(asRecord(config.current_period)?.type)
      const windowMinutes =
        periodType && /week/i.test(periodType)
          ? 7 * 24 * 60
          : periodType && /day/i.test(periodType)
            ? 24 * 60
            : undefined

      if (usedPercent == null && resetsAt == null) continue

      const tier = stringVal(item.ctx?.subscriptionTier)
      return {
        sourcePath: logPath,
        token: {
          rateLimits: {
            sevenDay: {
              ...(usedPercent != null
                ? { usedPercent: Math.min(100, Math.max(0, usedPercent)) }
                : {}),
              ...(resetsAt != null && Number.isFinite(resetsAt) ? { resetsAt } : {}),
              ...(windowMinutes != null ? { windowMinutes } : {}),
            },
          },
          ...(tier
            ? { rateLimitName: tier, rateLimitId: tier.toLowerCase() }
            : { rateLimitId: 'grok', rateLimitName: 'Grok' }),
          accuracy: 'estimated',
        },
      }
    }
  } catch {
    // no billing log
  }
  return {}
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

function mergeGrokToken(
  context: TokenPayload | undefined,
  billing: TokenPayload | undefined,
): TokenPayload | undefined {
  if (!context && !billing) return undefined
  return {
    ...billing,
    ...context,
    rateLimits: context?.rateLimits ?? billing?.rateLimits,
    rateLimitId: context?.rateLimitId ?? billing?.rateLimitId,
    rateLimitName: context?.rateLimitName ?? billing?.rateLimitName,
    accuracy:
      context?.accuracy === 'exact' || billing?.accuracy === 'exact' ? 'exact' : 'estimated',
  }
}

// ─── utils ───────────────────────────────────────────────────────────────────

function fingerprint(
  source: SyncSource | string,
  sessionId: string,
  cwd: string,
  mtimeMs: number,
  token: TokenPayload | undefined,
  model: string | undefined,
): string {
  return [
    source,
    sessionId,
    normalizePathKey(cwd),
    Math.floor(mtimeMs),
    model ?? '',
    token?.contextUsedPercent ?? '',
    token?.contextWindow ?? '',
    token?.input ?? '',
    token?.rateLimits?.fiveHour?.usedPercent ?? '',
    token?.rateLimits?.fiveHour?.resetsAt ?? '',
    token?.rateLimits?.sevenDay?.usedPercent ?? '',
    token?.rateLimits?.sevenDay?.resetsAt ?? '',
    token?.rateLimitId ?? '',
  ].join('|')
}

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

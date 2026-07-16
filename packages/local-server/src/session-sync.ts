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
import type { TokenPayload, TurnTiming } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import {
  asRecord,
  pickNumber,
  pickRateLimitId,
  pickRateLimitName,
  pickRateLimits,
} from '@codepulse/adapters'
import { readCodexRolloutSnapshotFromFile } from './quota-watcher.js'
import { mergeClaudeContextWithQuota, resolveClaudeAccountQuota } from './claude-quota.js'
import { WorkspacePathResolver } from './workspace-path.js'

const MAX_CODEX_FILES = 80
const CODEX_META_HEAD = 512 * 1024
/** Align with quota-watcher / hooks tails so token_count is not buried under tool noise. */
const CODEX_TAIL = 4 * 1024 * 1024
/**
 * Codex 无 active_sessions：用 rollout mtime 近似「CLI 仍活跃」。
 * 与 StatusHub 空闲 5 分钟剔除对齐——超过该窗口的 rollout 不再拉起项目卡片。
 * 仍要求本机有 codex 进程，避免把历史沉寂项目拉出来。
 */
const CODEX_LIVE_MS = 5 * 60_000
/** 进程在线但完全无近期写入时，取最近一份 rollout 只刷新账号额度（不复活多项目卡片）。 */
const CODEX_QUOTA_FALLBACK_MS = 48 * 60 * 60_000
/** Fewer boot rescans → less mutex pile-up; 0 + 0.5s + 2s still catches late writers. */
const BOOT_OFFSETS_MS = [0, 500, 2_000] as const
/** Steady full rescan when fs.watch is flaky (Windows). Lower = lower worst-case lag. */
const STEADY_INTERVAL_MS = 3_500
/** Coalesce bursty multi-file writes without waiting half a second. */
const WATCH_DEBOUNCE_MS = 200
/** Cache tasklist/pgrep so steady scans do not re-spawn every cycle. */
const CLI_ALIVE_CACHE_MS = 3_000
const CLI_ALIVE_TIMEOUT_MS = 1_000
const GROK_BILLING_MSG = 'billing: fetched credits config'
const CLAUDE_TRANSCRIPT_TAIL = 512 * 1024
/** Claude transcript rows lack turn IDs, so start/duration matching stays deliberately tight. */
const CLAUDE_DURATION_START_MATCH_TOLERANCE_MS = 5_000
const DEFAULT_CLAUDE_CONTEXT_WINDOW = pickNumberEnv(process.env.CODEPULSE_CONTEXT_WINDOW) ?? 200_000

/** Configures filesystem roots, timing, and test seams for {@link SessionSyncService}. */
export interface SessionSyncOptions {
  hub: StatusHub
  codexHome?: string
  grokHome?: string
  claudeHome?: string
  /**
   * 用户主目录（OAuth credentials + `~/.codepulse/claude-quota.json`）。
   * 测试传入临时目录以免读到本机真实额度缓存。
   */
  userHome?: string
  now?: () => number
  /** 测试时可关闭文件监听 */
  disableWatch?: boolean
  /** 测试注入：是否视为本机有 Codex CLI 进程 */
  codexProcessAlive?: () => boolean | Promise<boolean>
  /** 测试注入：Grok/Claude session 的 pid 是否存活 */
  isPidAlive?: (pid: number) => boolean
  /** 测试/嵌入时可替换 realpath 解析器。 */
  workspacePathResolver?: Pick<WorkspacePathResolver, 'resolve'>
}

/** A CLI source that can be scanned independently after a filesystem change. */
export type SessionSyncSource = 'codex' | 'grok' | 'claude_code'

/** Full-scan source set used for boot, steady polling, and explicit refreshes. */
const ALL_SYNC_SOURCES: readonly SessionSyncSource[] = ['codex', 'grok', 'claude_code']

/** Hydrates live CLI sessions into StatusHub from disk while avoiding historical sessions. */
export class SessionSyncService {
  private readonly hub: StatusHub
  private readonly codexHome: string
  private readonly grokHome: string
  private readonly claudeHome: string
  private readonly userHome: string
  private readonly now: () => number
  private readonly disableWatch: boolean
  private readonly codexProcessAlive: () => boolean | Promise<boolean>
  private readonly pidAlive: (pid: number) => boolean
  /** Canonicalizes aliases before dedupe keys and fingerprints are calculated. */
  private readonly workspacePaths: Pick<WorkspacePathResolver, 'resolve'>
  private timers: NodeJS.Timeout[] = []
  private steady?: NodeJS.Timeout
  private watchDebounce?: NodeJS.Timeout
  private watchers: FSWatcher[] = []
  /** Sources touched by fs.watch since the last debounced, source-scoped watch scan. */
  private dirtySources = new Set<SessionSyncSource>()
  private running = false
  private stopped = false
  private lastLogAt = 0
  /** sessionKey → full fingerprint (activity + quota) of last ingested payload */
  private fingerprints = new Map<string, string>()
  /** sessionKey → activity-only fingerprint (mtime/context; excludes rate limits) */
  private activityFingerprints = new Map<string, string>()
  private firstSync: Promise<void>
  private resolveFirstSync!: () => void
  private firstSyncDone = false

  constructor(options: SessionSyncOptions) {
    this.hub = options.hub
    this.userHome = options.userHome ?? homedir()
    this.codexHome = options.codexHome ?? process.env.CODEX_HOME ?? join(this.userHome, '.codex')
    this.grokHome = options.grokHome ?? process.env.GROK_HOME ?? join(this.userHome, '.grok')
    this.claudeHome =
      options.claudeHome ?? process.env.CLAUDE_HOME ?? join(this.userHome, '.claude')
    this.now = options.now ?? Date.now
    this.disableWatch = options.disableWatch ?? false
    this.codexProcessAlive = options.codexProcessAlive ?? (() => isCliProcessAlive('codex'))
    this.pidAlive = options.isPidAlive ?? isPidAlive
    this.workspacePaths = options.workspacePathResolver ?? new WorkspacePathResolver()
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
    this.dirtySources.clear()
    if (!this.firstSyncDone) {
      this.firstSyncDone = true
      this.resolveFirstSync()
    }
  }

  /**
   * Runs an immediate scan for the requested CLI sources.
   *
   * Duplicate sources are removed and an empty list is a no-op. Scan failures
   * are logged by the serialized scan path so background timers and IPC callers
   * can continue returning the latest StatusHub snapshot.
   *
   * @param sources CLI sources to scan; omit for a full safety-net scan.
   * @returns A promise that resolves after the requested scan attempt finishes.
   */
  async syncNow(sources: readonly SessionSyncSource[] = ALL_SYNC_SOURCES): Promise<void> {
    await this.syncOnce('manual', sources)
  }

  /**
   * Associates each watched filesystem root with the CLI source it can affect.
   *
   * Watchers are only low-latency hints; the steady timer still performs a full
   * scan when a platform cannot watch recursively or drops an event.
   */
  private startWatchers(): void {
    const roots: Array<{ root: string; source: SessionSyncSource }> = [
      { root: join(this.codexHome, 'sessions'), source: 'codex' },
      { root: join(this.grokHome, 'sessions'), source: 'grok' },
      { root: join(this.grokHome, 'active_sessions.json'), source: 'grok' },
      { root: join(this.grokHome, 'logs'), source: 'grok' },
      { root: join(this.claudeHome, 'sessions'), source: 'claude_code' },
      { root: join(this.claudeHome, 'projects'), source: 'claude_code' },
    ]
    for (const { root, source } of roots) {
      try {
        const w = watch(root, { recursive: true }, () => this.scheduleWatchSync(source))
        w.on('error', () => {
          // Directory may not exist yet; ignore.
        })
        this.watchers.push(w)
      } catch {
        // Missing path — polling still covers it.
      }
    }
  }

  /**
   * Collects source changes inside one debounce window before scanning only them.
   *
   * @param source CLI source associated with the filesystem notification.
   */
  private scheduleWatchSync(source: SessionSyncSource): void {
    if (this.stopped) return
    this.dirtySources.add(source)
    if (this.watchDebounce) clearTimeout(this.watchDebounce)
    this.watchDebounce = setTimeout(() => {
      this.watchDebounce = undefined
      const sources = [...this.dirtySources]
      this.dirtySources.clear()
      void this.syncOnce('watch', sources)
    }, WATCH_DEBOUNCE_MS)
    this.watchDebounce.unref?.()
  }

  /**
   * Serializes one disk-scan attempt to prevent boot, watch, and manual scans interleaving.
   *
   * @param reason Trigger label used for diagnostics.
   * @param requestedSources Sources selected for this attempt.
   */
  private async syncOnce(
    reason: string,
    requestedSources: readonly SessionSyncSource[] = ALL_SYNC_SOURCES,
  ): Promise<void> {
    if (this.stopped) return
    const sources = [...new Set(requestedSources)]
    if (sources.length === 0) return
    // Serialize scans so boot/watch/manual do not interleave.
    while (this.running) {
      await sleep(40)
      if (this.stopped) return
    }
    this.running = true
    const t0 = this.now()
    try {
      const counts: Record<SessionSyncSource, number> = {
        codex: 0,
        grok: 0,
        claude_code: 0,
      }
      await Promise.all(
        sources.map(async (source) => {
          if (source === 'codex') counts.codex = await this.syncCodex()
          else if (source === 'grok') counts.grok = await this.syncGrok()
          else counts.claude_code = await this.syncClaude()
        }),
      )
      const elapsed = this.now() - t0
      if (reason !== 'steady' || this.now() - this.lastLogAt > 60_000) {
        console.log(
          `[codepulse] session-sync (${reason}; ${sources.join(',')}): codex=${counts.codex} grok=${counts.grok} claude=${counts.claude_code} in ${elapsed}ms`,
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
    // No recently-active projects: still refresh account quota from the freshest
    // rollout, but do not resurrect multi-project cards from hours-old sessions.
    let quotaOnlyFallback = false
    if (files.length === 0) {
      const fallback = await listLiveCodexRollouts(
        sessionsRoot,
        this.now(),
        CODEX_QUOTA_FALLBACK_MS,
      )
      if (fallback[0]) {
        files = [fallback[0]]
        quotaOnlyFallback = true
      }
    }
    const now = this.now()
    let count = 0
    // Dedupe by workspace: keep the freshest *live* file per cwd.
    const byCwd = new Map<string, CodexWorkspaceCandidate>()

    for (const file of files) {
      try {
        const meta = await readCodexRolloutMeta(file.path)
        let cwd = meta.cwd
        if (!cwd) cwd = await findCwdInTail(file.path)
        if (!cwd) continue
        // Resolve aliases before project dedupe/fingerprints so one project has one hub key.
        cwd = await this.workspacePaths.resolve(cwd)

        const rollout = await readCodexRolloutSnapshotFromFile(file.path)
        const token = rollout.token ?? (await readCodexTokenFallback(file.path))
        const modelConfig = rollout.model
          ? {
              model: rollout.model,
              reasoningEffort: rollout.reasoningEffort,
              // JSONL envelopes normally carry ISO timestamps. File mtime is only
              // a stable fallback for legacy envelopes that omit one.
              modelObservedAt: rollout.modelObservedAt ?? Math.floor(file.mtimeMs),
            }
          : {}

        const key = normalizePathKey(cwd)
        const prev = byCwd.get(key)
        const candidate: CodexWorkspaceCandidate = {
          file,
          meta: { ...meta, cwd, ...modelConfig },
          token,
          turnTiming: rollout.turnTiming,
        }
        if (!prev || shouldPreferCodexWorkspaceCandidate(candidate, prev)) {
          byCwd.set(key, candidate)
        }
      } catch (err) {
        console.error('[codepulse] session-sync codex file failed', file.path, err)
      }
    }

    // Account weekly/5h quotas are global — pick best main + Spark separately.
    const accountFamilies = pickSharedCodexAccountQuotaFamilies([...byCwd.values()])
    const accountPrimary = accountFamilies.main ?? accountFamilies.spark

    if (quotaOnlyFallback) {
      const token = accountPrimary?.token
      if (!token?.rateLimits) return 0
      const mapKey = 'codex:quota-only'
      const fp = fingerprint('codex', 'quota-only', '', 0, token, undefined)
      if (this.fingerprints.get(mapKey) === fp) return 0
      this.fingerprints.set(mapKey, fp)
      this.hub.ingest({
        id: `session-sync:codex:quota:${now}`,
        source: 'codex',
        eventType: 'token_snapshot',
        token,
        tokenSourcePath: accountPrimary?.path,
        timestamp: now,
        internal: { sessionSync: true, quotaRefresh: true },
      })
      return 1
    }

    for (const { file, meta, token, turnTiming } of byCwd.values()) {
      const sessionId = meta.sessionId ?? sessionIdFromRolloutName(file.path)
      const cwd = meta.cwd!
      const payloadToken = withSharedCodexAccountQuota(
        token ?? { accuracy: 'unknown' as const, contextWindow: 256_000 },
        accountFamilies.main,
        accountFamilies.spark,
      )
      const mapKey = `codex:${sessionId}`
      const skip = this.classifyUnchanged(
        mapKey,
        'codex',
        sessionId,
        cwd,
        file.mtimeMs,
        payloadToken,
        meta.model,
        meta.reasoningEffort,
        meta.modelObservedAt,
        turnTiming,
      )
      if (skip === 'skip') continue

      const preferPath =
        (tokenLooksLikeSpark(payloadToken)
          ? accountFamilies.spark?.path
          : accountFamilies.main?.path) ??
        accountPrimary?.path ??
        file.path

      this.ingestHydrate({
        source: 'codex',
        sessionId,
        cwd,
        model: meta.model,
        reasoningEffort: meta.reasoningEffort,
        modelObservedAt: meta.modelObservedAt,
        turnTiming,
        token: payloadToken,
        tokenSourcePath: preferPath,
        now,
        // Quota-only churn must not refresh lastEventAt or unhide idle project cards.
        quotaOnly: skip === 'quota',
        activityRefresh: skip === 'activity',
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
      // Resolve before grouping active sessions by cwd to collapse symlink/junction aliases.
      const cwd = await this.workspacePaths.resolve(row.cwd)
      const key = normalizePathKey(cwd)
      // Active list is authoritative; last write wins if duplicates. Per-session
      // file mtimes are loaded below; wall-clock time must never become activity.
      byCwd.set(key, { sessionId: row.sessionId, cwd, mtimeMs: 0 })
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
      const turnTiming = await readGrokTurnTiming(this.grokHome, sessionId, cwd)
      const activityMtimeMs = await readGrokSessionActivityMtime(
        this.grokHome,
        sessionId,
        cwd,
        mtimeMs,
      )
      const contextToken = grokUsageToToken(usage)
      const token = mergeGrokToken(contextToken, billing.token)
      const model = typeof usage.model === 'string' ? usage.model : undefined
      const sourcePath =
        typeof usage.usage_source_path === 'string' ? usage.usage_source_path : billing.sourcePath

      const payloadToken = token ?? { accuracy: 'unknown' as const }
      const mapKey = `grok:${sessionId}`
      const skip = this.classifyUnchanged(
        mapKey,
        'grok',
        sessionId,
        cwd,
        activityMtimeMs,
        payloadToken,
        model,
        undefined,
        undefined,
        turnTiming,
      )
      if (skip === 'skip') return false

      this.ingestHydrate({
        source: 'grok',
        sessionId,
        cwd,
        model,
        turnTiming,
        token: payloadToken,
        tokenSourcePath: sourcePath,
        now,
        quotaOnly: skip === 'quota',
        activityRefresh: skip === 'activity',
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
    // Account-wide quota (OAuth usage or statusline cache) — independent of transcripts.
    const quota = await resolveClaudeAccountQuota({
      home: this.userHome,
      now: () => this.now(),
      timeoutMs: 1_200,
    }).catch(() => undefined)
    const thinkingConfig = await readClaudeThinkingConfig(this.claudeHome, now)

    const active = await readClaudeActiveSessions(this.claudeHome)
    let count = 0
    const byCwd = new Map<string, ClaudeActiveSession>()

    for (const row of active) {
      if (row.pid != null && !this.pidAlive(row.pid)) continue
      // Resolve before choosing the freshest project row so aliases do not create duplicate cards.
      const canonicalRow = { ...row, cwd: await this.workspacePaths.resolve(row.cwd) }
      // Prefer freshest session per project root.
      const key = normalizePathKey(canonicalRow.cwd)
      const prev = byCwd.get(key)
      if (!prev || canonicalRow.updatedAt >= prev.updatedAt) {
        byCwd.set(key, canonicalRow)
      }
    }

    for (const row of byCwd.values()) {
      if (
        await this.ingestClaudeSession(
          row.sessionId,
          row.cwd,
          now,
          row.updatedAt,
          row.status,
          quota,
          thinkingConfig,
        )
      ) {
        count += 1
      }
    }

    // No open project but we have account quota → quota-only shell (same as Grok).
    if (count === 0 && quota?.rateLimits) {
      const mapKey = 'claude_code:quota-only'
      const token = mergeClaudeContextWithQuota(undefined, quota)
      const fp = fingerprint('claude_code', 'quota-only', '', 0, token, undefined)
      if (this.fingerprints.get(mapKey) !== fp) {
        this.fingerprints.set(mapKey, fp)
        this.hub.ingest({
          id: `session-sync:claude:quota:${now}`,
          source: 'claude_code',
          eventType: 'token_snapshot',
          token,
          timestamp: now,
          internal: { sessionSync: true, quotaRefresh: true },
        })
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
    status: string | undefined,
    accountQuota?: Awaited<ReturnType<typeof resolveClaudeAccountQuota>>,
    thinkingConfig?: ClaudeThinkingConfig,
  ): Promise<boolean> {
    try {
      const transcript = await findClaudeTranscript(this.claudeHome, sessionId)
      const [usage, transcriptMtimeMs] = transcript
        ? await Promise.all([
            readClaudeTranscriptSnapshot(transcript, { status }),
            readFileMtime(transcript),
          ])
        : [undefined, undefined]
      const contextToken = claudeUsageToToken(usage)
      const model = usage?.model
      const reasoningEffort = thinkingConfig?.reasoningEffort
      const token = mergeClaudeContextWithQuota(contextToken, accountQuota, model)
      const mapKey = `claude_code:${sessionId}`
      const skip = this.classifyUnchanged(
        mapKey,
        'claude_code',
        sessionId,
        cwd,
        Math.max(updatedAt, transcriptMtimeMs ?? 0),
        token,
        model,
        reasoningEffort,
        undefined,
        usage?.turnTiming,
      )
      if (skip === 'skip') return false

      this.ingestHydrate({
        source: 'claude_code',
        sessionId,
        cwd,
        model,
        reasoningEffort,
        reasoningEffortObservedAt: thinkingConfig?.observedAt,
        turnTiming: usage?.turnTiming,
        token,
        tokenSourcePath: transcript,
        now,
        // Quota-only churn (account %) must not refresh project idle clock.
        quotaOnly: skip === 'quota',
        activityRefresh: skip === 'activity',
      })
      return true
    } catch (err) {
      console.error('[codepulse] session-sync claude failed', sessionId, err)
      return false
    }
  }

  /**
   * Decide whether disk data needs re-ingest.
   * - skip: nothing changed
   * - activity: mtime/context/model changed (refresh recency, show project)
   * - quota: only rate-limit fields changed (keep lastEventAt / taskHidden)
   * - rehydrate: a previously pruned slot is still discoverable, but its local
   *   source did not change since the previous scan
   *
   * A static `active` record alone is not a heartbeat: only a native session,
   * transcript, or rollout update may reset the watchdog. This prevents stale
   * busy markers from being shown as processing forever.
   */
  private classifyUnchanged(
    mapKey: string,
    source: SessionSyncSource,
    sessionId: string,
    cwd: string,
    mtimeMs: number,
    token: TokenPayload,
    model: string | undefined,
    reasoningEffort?: string,
    modelObservedAt?: number,
    turnTiming?: TurnTiming,
  ): 'skip' | 'activity' | 'quota' | 'rehydrate' {
    const full = fingerprint(
      source,
      sessionId,
      cwd,
      mtimeMs,
      token,
      model,
      reasoningEffort,
      modelObservedAt,
      turnTiming,
    )
    const activity = activityFingerprint(
      source,
      sessionId,
      cwd,
      mtimeMs,
      token,
      model,
      reasoningEffort,
      modelObservedAt,
      turnTiming,
    )
    const prevFull = this.fingerprints.get(mapKey)
    const prevActivity = this.activityFingerprints.get(mapKey)
    const inHub = this.hubHasSession(source, sessionId)

    this.fingerprints.set(mapKey, full)
    this.activityFingerprints.set(mapKey, activity)

    if (prevActivity !== activity) return 'activity'
    if (!inHub) return 'rehydrate'
    if (prevFull !== full) return 'quota'
    return 'skip'
  }

  private hubHasSession(source: SessionSyncSource, sessionId: string): boolean {
    return this.hub
      .snapshot()
      .agents.some((a) => a.agentType === source && a.externalSessionId === sessionId)
  }

  /**
   * First sighting: session_start + token_snapshot.
   * Later: token_snapshot only (avoids markContextStale on every poll).
   */
  private ingestHydrate(args: {
    source: SessionSyncSource
    sessionId: string
    cwd: string
    model?: string
    reasoningEffort?: string
    reasoningEffortObservedAt?: number
    modelObservedAt?: number
    turnTiming?: TurnTiming
    token: TokenPayload
    tokenSourcePath?: string
    now: number
    /** True when only account rate limits changed — do not bump project recency. */
    quotaOnly?: boolean
    /** True only when the native local source changed since its previous scan. */
    activityRefresh?: boolean
  }): void {
    const startKey = `started:${args.source}:${args.sessionId}`
    const alreadyStarted = this.fingerprints.has(startKey)
    const quotaOnly = args.quotaOnly === true

    // Quota-only updates never open a new project card.
    if (!alreadyStarted && !quotaOnly) {
      this.fingerprints.set(startKey, '1')
      this.hub.ingest({
        id: `session-sync:${args.source}:start:${args.sessionId}:${args.now}`,
        source: args.source,
        eventType: 'session_start',
        externalSessionId: args.sessionId,
        cwd: args.cwd,
        workspacePath: args.cwd,
        model: args.model,
        reasoningEffort: args.reasoningEffort,
        reasoningEffortObservedAt: args.reasoningEffortObservedAt,
        modelObservedAt: args.modelObservedAt,
        turnTiming: args.turnTiming,
        timestamp: args.now,
        internal: {
          sessionSync: true,
          ...(args.activityRefresh ? { activityRefresh: true } : {}),
        },
      })
    } else if (!alreadyStarted && quotaOnly) {
      // Remember start key so a later activity path can still session_start once.
      // (Do not mark started yet — first activity should open the card.)
    }

    if (!alreadyStarted && quotaOnly) {
      // No existing slot and no activity: skip creating a hidden orphan agent.
      // Account quota is still applied on other live projects / quota-only shell.
      return
    }

    this.hub.ingest({
      id: `session-sync:${args.source}:token:${args.sessionId}:${args.now}`,
      source: args.source,
      eventType: 'token_snapshot',
      externalSessionId: args.sessionId,
      cwd: args.cwd,
      workspacePath: args.cwd,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      reasoningEffortObservedAt: args.reasoningEffortObservedAt,
      modelObservedAt: args.modelObservedAt,
      turnTiming: args.turnTiming,
      token: args.token,
      tokenSourcePath: args.tokenSourcePath,
      timestamp: args.now,
      internal: {
        sessionSync: true,
        ...(args.activityRefresh ? { activityRefresh: true } : {}),
        ...(quotaOnly ? { quotaRefresh: true } : {}),
      },
    })
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
  reasoningEffort?: string
  modelObservedAt?: number
}

/** One live Codex rollout candidate for a deduplicated workspace card. */
interface CodexWorkspaceCandidate {
  file: RolloutFile
  meta: CodexMeta
  token?: TokenPayload
  turnTiming?: TurnTiming
}

/**
 * Chooses which same-workspace Codex rollout represents the current project.
 *
 * Token writes update mtime long after a model change. Prefer the native model
 * configuration timestamp first, then mtime only as a deterministic fallback,
 * so an old Sol session cannot displace a newer Terra configuration.
 *
 * @param candidate Newly scanned rollout candidate.
 * @param current Candidate already selected for the workspace.
 * @returns True when `candidate` should replace `current`.
 */
function shouldPreferCodexWorkspaceCandidate(
  candidate: CodexWorkspaceCandidate,
  current: CodexWorkspaceCandidate,
): boolean {
  const candidateObservedAt = candidate.meta.modelObservedAt ?? 0
  const currentObservedAt = current.meta.modelObservedAt ?? 0
  if (candidateObservedAt !== currentObservedAt) return candidateObservedAt > currentObservedAt
  return candidate.file.mtimeMs >= current.file.mtimeMs
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

/**
 * Reads stable session identity from a rollout header.
 *
 * Header records can describe an earlier turn, so current model configuration is
 * intentionally excluded here and is read from the newest rollout-tail snapshot.
 *
 * @param file Absolute rollout JSONL path.
 * @returns Workspace and session identifiers available near the file head.
 */
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
        }
      }
    } catch {
      // Truncated huge first line — try regex extraction.
      const partial = extractMetaFromPartialLine(line)
      if (partial.cwd || partial.sessionId) {
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
  return {
    cwd: cwd ? unescapeJsonString(cwd) : undefined,
    sessionId: sessionId ?? undefined,
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

/**
 * Fallback when the primary quota reader returns nothing.
 * Context only from last_token_usage — never total_token_usage, never raw expired limits
 * (rate limits always go through readCodexQuotaTokenFromFile soft-reset path).
 */
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
      if (!last) continue
      const window = num(info.model_context_window) ?? num(payload.model_context_window) ?? 256_000
      const input = num(last.input_tokens)
      const pct = input != null && window > 0 ? Math.min(100, (input / window) * 100) : undefined
      if (pct == null && input == null) continue
      return {
        input,
        total: num(last.total_tokens),
        contextUsedPercent: pct,
        contextWindow: window,
        // Deliberately omit rateLimits — use readCodexQuotaTokenFromFile for those.
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

type CodexQuotaRow = { file: RolloutFile; token?: TokenPayload }
type AccountQuotaPick = { token: TokenPayload; mtimeMs: number; path: string }

/**
 * Context is per-project; rate limits are account-wide.
 * Overlay main (and optional Spark) account snapshots; keep quotaBuckets so dual meters work.
 */
function withSharedCodexAccountQuota(
  project: TokenPayload,
  accountMain: AccountQuotaPick | undefined,
  accountSpark: AccountQuotaPick | undefined,
): TokenPayload {
  if (!accountMain?.token.rateLimits && !accountSpark?.token.rateLimits) return project

  // Top-level prefers main account weekly (never let a fresher Spark 0% clobber it).
  // Dual meters still live in quotaBuckets; display layer picks by active model.
  const top = accountMain ?? accountSpark
  if (!top?.token.rateLimits) return project

  const now = Date.now()
  const buckets: NonNullable<TokenPayload['quotaBuckets']> = {
    ...(project.quotaBuckets ?? {}),
  }
  if (accountMain?.token.rateLimits) {
    const id = accountMain.token.rateLimitId?.trim() || 'codex'
    buckets[id] = {
      rateLimitId: accountMain.token.rateLimitId,
      rateLimitName: accountMain.token.rateLimitName,
      rateLimits: accountMain.token.rateLimits,
      updatedAt: accountMain.mtimeMs || now,
    }
  }
  if (accountSpark?.token.rateLimits) {
    const id = accountSpark.token.rateLimitId?.trim() || 'codex_bengalfox'
    buckets[id] = {
      rateLimitId: accountSpark.token.rateLimitId,
      rateLimitName: accountSpark.token.rateLimitName,
      rateLimits: accountSpark.token.rateLimits,
      updatedAt: accountSpark.mtimeMs || now,
    }
  }

  return {
    ...project,
    rateLimits: top.token.rateLimits,
    rateLimitId: top.token.rateLimitId ?? project.rateLimitId,
    rateLimitName: top.token.rateLimitName ?? project.rateLimitName,
    quotaBuckets: Object.keys(buckets).length > 0 ? buckets : undefined,
  }
}

/**
 * Pick best main + best Spark account snapshots from live rollouts.
 * Prefer weekly (sevenDay) signal for ranking — matches Codex UI (no 5h bar).
 */
function pickSharedCodexAccountQuotaFamilies(rows: CodexQuotaRow[]): {
  main?: AccountQuotaPick
  spark?: AccountQuotaPick
} {
  const withLimits = rows.filter((row) => row.token?.rateLimits)
  if (withLimits.length === 0) return {}

  let main: AccountQuotaPick | undefined
  let spark: AccountQuotaPick | undefined
  for (const row of withLimits) {
    const token = row.token!
    const candidate: AccountQuotaPick = {
      token,
      mtimeMs: row.file.mtimeMs,
      path: row.file.path,
    }
    if (tokenLooksLikeSpark(token)) {
      if (!spark || compareAccountQuotaSnapshots(candidate, spark) > 0) spark = candidate
    } else if (!main || compareAccountQuotaSnapshots(candidate, main) > 0) {
      main = candidate
    }
  }
  return { main, spark }
}

/** Positive when `a` is a better account-wide snapshot than `b` (weekly-first). */
function compareAccountQuotaSnapshots(a: AccountQuotaPick, b: AccountQuotaPick): number {
  const aSeven = a.token.rateLimits?.sevenDay
  const bSeven = b.token.rateLimits?.sevenDay
  const aFive = a.token.rateLimits?.fiveHour
  const bFive = b.token.rateLimits?.fiveHour

  // Prefer later weekly reset, then higher weekly %; five-hour only as weak tiebreak.
  const aWeekReset = normalizeResetAtMs(aSeven?.resetsAt)
  const bWeekReset = normalizeResetAtMs(bSeven?.resetsAt)
  if (aWeekReset !== bWeekReset) return aWeekReset - bWeekReset

  const aWeekUsed = aSeven?.usedPercent ?? -1
  const bWeekUsed = bSeven?.usedPercent ?? -1
  if (aWeekUsed !== bWeekUsed) return aWeekUsed - bWeekUsed

  const aFiveReset = normalizeResetAtMs(aFive?.resetsAt)
  const bFiveReset = normalizeResetAtMs(bFive?.resetsAt)
  if (aFiveReset !== bFiveReset) return aFiveReset - bFiveReset

  const aFiveUsed = aFive?.usedPercent ?? -1
  const bFiveUsed = bFive?.usedPercent ?? -1
  if (aFiveUsed !== bFiveUsed) return aFiveUsed - bFiveUsed

  return a.mtimeMs - b.mtimeMs
}

function tokenLooksLikeSpark(token: TokenPayload | undefined): boolean {
  if (!token) return false
  const s = `${token.rateLimitId ?? ''} ${token.rateLimitName ?? ''}`.toLowerCase()
  return s.includes('spark') || s.includes('bengalfox')
}

function normalizeResetAtMs(resetsAt: number | undefined): number {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return 0
  return resetsAt < 1_000_000_000_000 ? resetsAt * 1000 : resetsAt
}

// ─── Claude Code ─────────────────────────────────────────────────────────────

interface ClaudeActiveSession {
  sessionId: string
  cwd: string
  pid?: number
  updatedAt: number
  /** Native process status such as `busy` or `idle`. */
  status?: string
}

/** Native Claude Code thinking-depth configuration read from its settings file. */
interface ClaudeThinkingConfig {
  reasoningEffort?: string
  /** File mtime or a missing-file tombstone timestamp, in epoch milliseconds. */
  observedAt: number
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
      const updatedAt =
        parseLocalTimestamp(raw.updatedAt) ?? parseLocalTimestamp(raw.statusUpdatedAt) ?? 0
      const status = stringVal(raw.status)?.trim().toLowerCase()
      out.push({ sessionId, cwd, pid, updatedAt, status })
    } catch {
      // ignore corrupt session files
    }
  }
  return out
}

/**
 * Reads Claude Code's global `effortLevel` setting without deriving a level from
 * transcript thinking text or reasoning token counts.
 *
 * A successfully parsed settings file is authoritative even when it omits the
 * field, allowing a removed setting to clear a previously displayed value. A
 * transient parse/read error is ignored so a partial editor write does not erase
 * valid UI state. A missing file is an intentional unknown-settings tombstone.
 *
 * @param claudeHome Claude Code home directory.
 * @param missingObservedAt Timestamp to use when the settings file is absent.
 * @returns The known native setting snapshot, or `undefined` on transient failure.
 */
async function readClaudeThinkingConfig(
  claudeHome: string,
  missingObservedAt: number,
): Promise<ClaudeThinkingConfig | undefined> {
  const settingsPath = join(claudeHome, 'settings.json')
  try {
    const [text, metadata] = await Promise.all([readFile(settingsPath, 'utf8'), stat(settingsPath)])
    const settings = asRecord(JSON.parse(text.replace(/^\uFEFF/, '')))
    return {
      reasoningEffort: normalizeClaudeReasoningEffort(
        settings?.effortLevel ?? settings?.effort_level,
      ),
      observedAt: Math.max(0, Math.floor(metadata.mtimeMs)),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { observedAt: missingObservedAt }
    }
    return undefined
  }
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
  /** Native task timing recovered without retaining transcript message content. */
  turnTiming?: TurnTiming
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

/** Native Claude process fields needed only for timing recovery. */
interface ClaudeTimingContext {
  status?: string
}

/** A parsed Claude `system/turn_duration` record. */
interface ClaudeTurnCompletion {
  elapsedMs: number
  observedAt: number
}

/**
 * Combines existing transcript usage parsing with a privacy-preserving timing
 * scan. The timing pass reads only record type, timestamps, and duration fields.
 *
 * @param transcriptPath Absolute Claude transcript JSONL path.
 * @param timingContext Native active-session status.
 * @returns The latest display-safe usage and timing data, when available.
 */
async function readClaudeTranscriptSnapshot(
  transcriptPath: string,
  timingContext: ClaudeTimingContext,
): Promise<ClaudeTranscriptUsage | undefined> {
  const [usage, turnTiming] = await Promise.all([
    readClaudeTranscriptUsage(transcriptPath),
    readClaudeTurnTiming(transcriptPath, timingContext),
  ])
  if (!usage && !turnTiming) return undefined
  return { ...usage, ...(turnTiming ? { turnTiming } : {}) }
}

/**
 * Reads only Claude's human-prompt and native `turn_duration` lifecycle fields.
 * It deliberately excludes message text, assistant text, and tool output.
 *
 * @param transcriptPath Absolute Claude transcript JSONL path.
 * @param timingContext Native active-session status.
 * @returns A normalized turn timing snapshot, when local CLI data provides one.
 */
async function readClaudeTurnTiming(
  transcriptPath: string,
  timingContext: ClaudeTimingContext,
): Promise<TurnTiming | undefined> {
  try {
    const text = await readTailFile(transcriptPath, CLAUDE_TRANSCRIPT_TAIL)
    const lines = text.trim().split(/\r?\n/)
    let latestPromptAt: number | undefined
    let latestCompletion: ClaudeTurnCompletion | undefined

    for (let i = lines.length - 1; i >= 0; i--) {
      let item: {
        type?: string
        timestamp?: unknown
        userType?: unknown
        isMeta?: unknown
        isSidechain?: unknown
        toolUseResult?: unknown
        subtype?: unknown
        durationMs?: unknown
        duration_ms?: unknown
        message?: { role?: unknown }
      }
      try {
        item = JSON.parse(lines[i] ?? '')
      } catch {
        continue
      }

      const timestamp = parseLocalTimestamp(item.timestamp)
      if (
        !latestCompletion &&
        item.type === 'system' &&
        stringVal(item.subtype) === 'turn_duration' &&
        timestamp != null
      ) {
        const elapsedMs = num(item.durationMs) ?? num(item.duration_ms)
        if (elapsedMs != null && elapsedMs >= 0) {
          latestCompletion = { elapsedMs, observedAt: timestamp }
        }
      }
      if (!latestPromptAt && isClaudeHumanPrompt(item) && timestamp != null) {
        latestPromptAt = timestamp
      }
    }

    return selectClaudeTurnTiming(latestPromptAt, latestCompletion, timingContext)
  } catch {
    return undefined
  }
}

/**
 * Chooses active timing only when a busy Claude process has a prompt newer than
 * its latest native completion. Otherwise it retains the last terminal duration.
 *
 * @param promptAt Latest human prompt timestamp from the transcript.
 * @param completion Latest native `turn_duration` record from the transcript.
 * @param context Native active-session status.
 * @returns A normalized CLI timing snapshot, when available.
 */
function selectClaudeTurnTiming(
  promptAt: number | undefined,
  completion: ClaudeTurnCompletion | undefined,
  context: ClaudeTimingContext,
): TurnTiming | undefined {
  const promptIsCurrent =
    promptAt != null && (completion == null || promptAt > completion.observedAt)
  if (isClaudeBusy(context.status) && promptIsCurrent) {
    return { state: 'active', startedAt: promptAt, observedAt: promptAt }
  }
  if (completion && !promptIsCurrent) {
    const startedAt = matchClaudeCompletionStart(promptAt, completion)
    return {
      state: 'completed',
      ...(startedAt != null ? { startedAt } : {}),
      elapsedMs: completion.elapsedMs,
      observedAt: completion.observedAt,
    }
  }
  // A Claude session's own start is not a task start. Without a transcript
  // prompt, leave timing unknown instead of displaying accumulated idle time.
  return undefined
}

/**
 * Associates a Claude `turn_duration` with a prompt only when its independently
 * recorded duration predicts the same start timestamp. Claude transcript rows
 * have no shared turn ID, and later external user rows can otherwise be matched
 * to the wrong terminal duration.
 *
 * @param promptAt Latest eligible human prompt timestamp.
 * @param completion Native terminal duration record.
 * @returns The verified prompt start, or `undefined` when the rows are ambiguous.
 */
function matchClaudeCompletionStart(
  promptAt: number | undefined,
  completion: ClaudeTurnCompletion,
): number | undefined {
  if (promptAt == null) return undefined
  const inferredStart = completion.observedAt - completion.elapsedMs
  return Math.abs(inferredStart - promptAt) <= CLAUDE_DURATION_START_MATCH_TOLERANCE_MS
    ? promptAt
    : undefined
}

/**
 * Identifies a human-entered Claude transcript message without inspecting or
 * retaining its content. Tool results are represented as user messages too.
 *
 * @param item Parsed Claude transcript row.
 * @returns `true` when the row represents an external human prompt.
 */
function isClaudeHumanPrompt(item: {
  type?: string
  userType?: unknown
  isMeta?: unknown
  isSidechain?: unknown
  toolUseResult?: unknown
  message?: { role?: unknown }
}): boolean {
  const userType = stringVal(item.userType)
  return (
    item.type === 'user' &&
    item.message?.role === 'user' &&
    item.toolUseResult == null &&
    item.isMeta !== true &&
    item.isSidechain !== true &&
    (userType == null || userType === 'external')
  )
}

/**
 * Checks whether Claude's native process status indicates it is actively working.
 *
 * @param status Native status string from `~/.claude/sessions`.
 * @returns `true` for known active statuses.
 */
function isClaudeBusy(status: string | undefined): boolean {
  const normalized = status?.trim().toLowerCase()
  return normalized === 'busy' || normalized === 'working' || normalized === 'running'
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

const cliAliveCache = new Map<string, { value: boolean; at: number }>()

/**
 * Best-effort: is any CLI binary of this family currently running?
 * Avoids resurfacing disk history after the user has closed every terminal.
 * Cached briefly so 3.5s steady scans do not re-run tasklist every cycle.
 */
async function isCliProcessAlive(kind: 'codex' | 'grok'): Promise<boolean> {
  const now = Date.now()
  const cached = cliAliveCache.get(kind)
  if (cached && now - cached.at < CLI_ALIVE_CACHE_MS) return cached.value

  let value = true
  try {
    if (process.platform === 'win32') {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      // tasklist is always available; filter by image name.
      const image = kind === 'codex' ? 'codex.exe' : 'grok.exe'
      const { stdout } = await execFileAsync('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH'], {
        windowsHide: true,
        timeout: CLI_ALIVE_TIMEOUT_MS,
      })
      value = stdout.toLowerCase().includes(image.toLowerCase())
    } else {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execFileAsync = promisify(execFile)
      const { stdout } = await execFileAsync('pgrep', ['-x', kind], {
        timeout: CLI_ALIVE_TIMEOUT_MS,
      }).catch(() => ({ stdout: '' }))
      value = String(stdout).trim().length > 0
    }
  } catch {
    // If detection fails, fall through to mtime / active_sessions heuristics.
    value = true
  }
  cliAliveCache.set(kind, { value, at: now })
  return value
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

/**
 * Reads Grok's per-turn lifecycle events without using session-duration counters
 * that include idle time and earlier turns.
 *
 * @param grokHome Grok CLI home directory.
 * @param sessionId Native Grok session identifier.
 * @param cwd Workspace path used to locate the encoded session directory.
 * @returns The latest active or completed turn timing, when available.
 */
async function readGrokTurnTiming(
  grokHome: string,
  sessionId: string,
  cwd: string,
): Promise<TurnTiming | undefined> {
  const sessionDir = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId)
  try {
    const text = await readTailFile(join(sessionDir, 'events.jsonl'), 512 * 1024)
    const startedById = new Map<string, number>()
    const anonymousStarts: number[] = []
    let latestCompleted: { startedAt: number; elapsedMs: number; observedAt: number } | undefined

    for (const line of text.trim().split(/\r?\n/)) {
      let item: Record<string, unknown>
      try {
        item = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const payload = asRecord(item.payload) ?? asRecord(item.event) ?? item
      const type = stringVal(item.type) ?? stringVal(item.event_type) ?? stringVal(payload?.type)
      const timestamp = parseLocalTimestamp(
        item.ts ?? item.timestamp ?? payload?.ts ?? payload?.timestamp,
      )
      if (timestamp == null) continue
      const turnId =
        stringVal(item.turn_id) ??
        stringVal(item.turnId) ??
        stringVal(payload?.turn_id) ??
        stringVal(payload?.turnId)

      if (type === 'turn_started') {
        if (turnId) startedById.set(turnId, timestamp)
        else anonymousStarts.push(timestamp)
        continue
      }
      if (type !== 'turn_ended') continue

      const startedAt = turnId ? startedById.get(turnId) : anonymousStarts.shift()
      if (turnId) startedById.delete(turnId)
      if (startedAt == null) continue
      const elapsedMs = Math.max(0, timestamp - startedAt)
      if (!latestCompleted || timestamp >= latestCompleted.observedAt) {
        latestCompleted = { startedAt, elapsedMs, observedAt: timestamp }
      }
    }

    const activeStartedAt = [...startedById.values(), ...anonymousStarts].reduce<
      number | undefined
    >(
      (earliest, startedAt) => (!earliest || startedAt < earliest ? startedAt : earliest),
      undefined,
    )
    if (activeStartedAt != null) {
      return { state: 'active', startedAt: activeStartedAt, observedAt: activeStartedAt }
    }
    if (latestCompleted) {
      return {
        state: 'completed',
        startedAt: latestCompleted.startedAt,
        elapsedMs: latestCompleted.elapsedMs,
        observedAt: latestCompleted.observedAt,
      }
    }
  } catch {
    // No usable lifecycle file; session lifetime must not be shown as turn time.
  }
  return undefined
}

/**
 * Finds the freshest Grok file scoped to one active session. This supports
 * liveness only when Grok actually writes session data; the global
 * `active_sessions.json` list alone must not keep a stale task alive forever.
 *
 * @param grokHome Grok CLI home directory.
 * @param sessionId Native Grok session identifier.
 * @param cwd Workspace path used to locate the encoded session directory.
 * @param fallbackMtimeMs Existing source mtime when no session file is readable.
 * @returns Epoch milliseconds of the freshest session-scoped file mtime.
 */
async function readGrokSessionActivityMtime(
  grokHome: string,
  sessionId: string,
  cwd: string,
  fallbackMtimeMs: number,
): Promise<number> {
  const sessionDir = join(grokHome, 'sessions', encodeURIComponent(cwd), sessionId)
  const mtimes = await Promise.all(
    ['events.jsonl', 'updates.jsonl', 'signals.json', 'summary.json'].map(readFileNameMtime),
  )
  return Math.max(fallbackMtimeMs, ...mtimes.filter((mtime): mtime is number => mtime != null))

  /**
   * Reads one candidate session file mtime while keeping a missing file neutral.
   *
   * @param fileName Session-relative filename.
   * @returns Its mtime, or `undefined` when not readable.
   */
  async function readFileNameMtime(fileName: string): Promise<number | undefined> {
    return readFileMtime(join(sessionDir, fileName))
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

/** Full payload identity including account rate limits. */
function fingerprint(
  source: SessionSyncSource | string,
  sessionId: string,
  cwd: string,
  mtimeMs: number,
  token: TokenPayload | undefined,
  model: string | undefined,
  reasoningEffort?: string,
  modelObservedAt?: number,
  turnTiming?: TurnTiming,
): string {
  return [
    activityFingerprint(
      source,
      sessionId,
      cwd,
      mtimeMs,
      token,
      model,
      reasoningEffort,
      modelObservedAt,
      turnTiming,
    ),
    token?.rateLimits?.fiveHour?.usedPercent ?? '',
    token?.rateLimits?.fiveHour?.resetsAt ?? '',
    token?.rateLimits?.sevenDay?.usedPercent ?? '',
    token?.rateLimits?.sevenDay?.resetsAt ?? '',
    token?.rateLimitId ?? '',
  ].join('|')
}

/**
 * Project activity identity — excludes rate limits so account-wide quota ticks
 * do not refresh lastEventAt or resurrect idle project cards.
 */
function activityFingerprint(
  source: SessionSyncSource | string,
  sessionId: string,
  cwd: string,
  mtimeMs: number,
  token: TokenPayload | undefined,
  model: string | undefined,
  reasoningEffort?: string,
  modelObservedAt?: number,
  turnTiming?: TurnTiming,
): string {
  return [
    source,
    sessionId,
    normalizePathKey(cwd),
    Math.floor(mtimeMs),
    model ?? '',
    reasoningEffort ?? '',
    modelObservedAt ?? '',
    turnTiming?.state ?? '',
    turnTiming?.startedAt ?? '',
    turnTiming?.elapsedMs ?? '',
    turnTiming?.observedAt ?? '',
    token?.contextUsedPercent ?? '',
    token?.contextWindow ?? '',
    token?.input ?? '',
    token?.total ?? '',
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

/**
 * Reads a local file's modification time without treating a failed stat as
 * session activity. Callers use this only as evidence that a CLI wrote its own
 * transcript or per-session file since the preceding scan.
 *
 * @param file Absolute local CLI data path.
 * @returns Epoch milliseconds of the current file mtime, when readable.
 */
async function readFileMtime(file: string): Promise<number | undefined> {
  try {
    const mtimeMs = (await stat(file)).mtimeMs
    return Number.isFinite(mtimeMs) && mtimeMs > 0 ? Math.floor(mtimeMs) : undefined
  } catch {
    return undefined
  }
}

function stringVal(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Validates and normalizes Claude's compact native effort enum for display.
 *
 * @param value Candidate value from `settings.json`.
 * @returns A lowercase effort name, or `undefined` for absent/malformed input.
 */
function normalizeClaudeReasoningEffort(value: unknown): string | undefined {
  const normalized = stringVal(value)?.trim().toLowerCase()
  return normalized && /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : undefined
}

function num(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

/**
 * Parses CLI timestamp variants into epoch milliseconds. Local files mix ISO
 * strings, Unix seconds, and epoch milliseconds across the supported tools.
 *
 * @param value Candidate CLI timestamp.
 * @returns Epoch milliseconds when the value is finite and positive.
 */
function parseLocalTimestamp(value: unknown): number | undefined {
  const numeric = normalizeEpochMilliseconds(value)
  if (numeric != null) return numeric
  if (typeof value !== 'string' || !value.trim()) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * Normalizes a numeric Unix-seconds or epoch-milliseconds value.
 *
 * @param value Candidate numeric timestamp.
 * @returns Epoch milliseconds when the value is finite and positive.
 */
function normalizeEpochMilliseconds(value: unknown): number | undefined {
  const numeric = num(value)
  if (numeric == null || numeric <= 0) return undefined
  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

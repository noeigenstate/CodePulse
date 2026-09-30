/**
 * Usage ledger: per-request token usage and per-prompt rounds read straight
 * from the CLIs' own logs (see local-server/usage-scanner), plus the
 * aggregations behind the Usage dashboard.
 *
 * Every row is keyed by a source-derived id and written with INSERT OR IGNORE,
 * so rescanning a file never double counts. Cost is not stored: it is derived
 * at query time from @codepulse/shared pricing, so price-table updates apply
 * to history too.
 *
 * @module storage/usage-ledger
 */
import type Database from 'better-sqlite3'
import {
  findModelPrice,
  priceRequest,
  PRICING_AS_OF,
  type AgentType,
  type StatsRangePreset,
  type StatsTrendGranularity,
  type UsageLedgerSession,
  type UsageLedgerSnapshot,
  type UsageLedgerTotals,
} from '@codepulse/shared'
import { toPersistedPreview } from './privacy.js'

/** One API request as billed by the provider. */
export interface UsageRecordInput {
  id: string
  agentType: AgentType
  sessionId: string
  workspacePath?: string
  model?: string
  timestamp: number
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
  reasoning?: number
}

/** One prompt the user typed (a "round"). */
export interface UsagePromptInput {
  id: string
  agentType: AgentType
  sessionId: string
  workspacePath?: string
  model?: string
  timestamp: number
  text?: string
}

/** Incremental read position of one log file. */
export interface UsageScanFileState {
  path: string
  offset: number
  size: number
  mtimeMs: number
  /** Source-specific carry-over (e.g. Codex model / cumulative total). */
  context?: Record<string, unknown>
}

export function ensureUsageLedgerSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS usage_records (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_path TEXT,
      model TEXT,
      ts INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_5m_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_1h_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS usage_records_ts_idx ON usage_records (ts);
    CREATE INDEX IF NOT EXISTS usage_records_session_idx ON usage_records (agent_type, session_id);

    CREATE TABLE IF NOT EXISTS usage_prompts (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL,
      session_id TEXT NOT NULL,
      workspace_path TEXT,
      model TEXT,
      ts INTEGER NOT NULL,
      preview TEXT
    );
    CREATE INDEX IF NOT EXISTS usage_prompts_ts_idx ON usage_prompts (ts);
    CREATE INDEX IF NOT EXISTS usage_prompts_session_idx ON usage_prompts (agent_type, session_id);

    CREATE TABLE IF NOT EXISTS usage_scan_files (
      path TEXT PRIMARY KEY,
      offset INTEGER NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL,
      context TEXT
    );
  `)
}

/** Prepared writers for one scan pass; call inside a transaction for speed. */
export class UsageLedgerWriter {
  private insertRecord: Database.Statement
  private replaceRecord: Database.Statement
  private insertPrompt: Database.Statement
  private fillPromptModel: Database.Statement
  private latestSessionModel: Database.Statement
  private readFile: Database.Statement
  private writeFile: Database.Statement

  constructor(readonly sqlite: Database.Database) {
    ensureUsageLedgerSchema(sqlite)
    const recordSql = `(id, agent_type, session_id, workspace_path, model, ts, input_tokens,
      cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, output_tokens, reasoning_tokens)
      VALUES (@id, @agentType, @sessionId, @workspacePath, @model, @timestamp, @input,
      @cacheRead, @cacheWrite5m, @cacheWrite1h, @output, @reasoning)`
    this.insertRecord = sqlite.prepare(`INSERT OR IGNORE INTO usage_records ${recordSql}`)
    this.replaceRecord = sqlite.prepare(`INSERT OR REPLACE INTO usage_records ${recordSql}`)
    this.insertPrompt = sqlite.prepare(`INSERT OR IGNORE INTO usage_prompts
      (id, agent_type, session_id, workspace_path, model, ts, preview)
      VALUES (@id, @agentType, @sessionId, @workspacePath, @model, @timestamp, @preview)`)
    this.fillPromptModel = sqlite.prepare(`UPDATE usage_prompts SET model = ?
      WHERE agent_type = ? AND session_id = ? AND model IS NULL AND ts <= ?`)
    this.latestSessionModel = sqlite.prepare(`SELECT model FROM usage_records
      WHERE agent_type = ? AND session_id = ? AND ts <= ? AND model IS NOT NULL
      ORDER BY ts DESC LIMIT 1`)
    this.readFile = sqlite.prepare(
      `SELECT path, offset, size, mtime_ms AS mtimeMs, context FROM usage_scan_files WHERE path = ?`,
    )
    this.writeFile = sqlite.prepare(`INSERT OR REPLACE INTO usage_scan_files
      (path, offset, size, mtime_ms, context) VALUES (?, ?, ?, ?, ?)`)
  }

  /**
   * Adds a request; a repeated id is ignored.
   *
   * @param record Request usage.
   * @param replace Overwrite an existing row (for sources that only expose running totals).
   */
  record(record: UsageRecordInput, replace = false): void {
    ;(replace ? this.replaceRecord : this.insertRecord).run({
      ...record,
      workspacePath: record.workspacePath ?? null,
      model: record.model ?? null,
      reasoning: record.reasoning ?? 0,
    })
    // Claude logs the prompt before its answering model is known.
    if (record.model) {
      this.fillPromptModel.run(record.model, record.agentType, record.sessionId, record.timestamp)
    }
  }

  /**
   * Adds a typed prompt; a repeated id is ignored. Without a known model it
   * inherits the session's latest model (a prompt typed mid-turn may never get
   * a reply of its own), falling back to the next reply via {@link record}.
   *
   * @param prompt Prompt metadata and text (stored as a short preview only).
   */
  prompt(prompt: UsagePromptInput): void {
    const inherited =
      prompt.model ??
      (
        this.latestSessionModel.get(prompt.agentType, prompt.sessionId, prompt.timestamp) as
          | { model: string }
          | undefined
      )?.model
    this.insertPrompt.run({
      id: prompt.id,
      agentType: prompt.agentType,
      sessionId: prompt.sessionId,
      workspacePath: prompt.workspacePath ?? null,
      model: inherited ?? null,
      timestamp: prompt.timestamp,
      preview: toPersistedPreview(prompt.text) ?? null,
    })
  }

  fileState(path: string): UsageScanFileState | undefined {
    const row = this.readFile.get(path) as
      | { path: string; offset: number; size: number; mtimeMs: number; context: string | null }
      | undefined
    if (!row) return undefined
    let context: Record<string, unknown> | undefined
    try {
      context = row.context ? (JSON.parse(row.context) as Record<string, unknown>) : undefined
    } catch {
      context = undefined
    }
    return { ...row, context }
  }

  saveFileState(state: UsageScanFileState): void {
    this.writeFile.run(
      state.path,
      state.offset,
      state.size,
      Math.round(state.mtimeMs),
      state.context ? JSON.stringify(state.context) : null,
    )
  }
}

// ───────────────────────────── Aggregation ─────────────────────────────

export interface UsageLedgerQuery {
  range: StatsRangePreset
  granularity?: StatsTrendGranularity
  now?: number
}

interface RecordRow {
  agentType: AgentType
  sessionId: string
  workspacePath: string | null
  model: string | null
  ts: number
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  output: number
}

interface PromptRow {
  agentType: AgentType
  sessionId: string
  workspacePath: string | null
  model: string | null
  ts: number
  preview: string | null
}

const DAY_MS = 24 * 60 * 60_000
/** Longest session list returned for the rounds view. */
const SESSION_LIMIT = 30

function emptyTotals(): UsageLedgerTotals {
  return {
    requests: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    tokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    rounds: 0,
  }
}

function addRecord(totals: UsageLedgerTotals, row: RecordRow, cost: number | undefined): void {
  const cacheWrite = row.cacheWrite5m + row.cacheWrite1h
  const tokens = row.input + row.cacheRead + cacheWrite + row.output
  totals.requests += 1
  totals.input += row.input
  totals.cacheRead += row.cacheRead
  totals.cacheWrite += cacheWrite
  totals.output += row.output
  totals.tokens += tokens
  if (cost === undefined) totals.unpricedTokens += tokens
  else totals.costUsd += cost
}

/**
 * Local-time start of the requested range.
 *
 * @param range Preset.
 * @param now Current time.
 * @returns Inclusive range start in epoch ms.
 */
export function usageRangeStart(range: StatsRangePreset, now: number): number {
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  const days = range === 'today' ? 0 : range === '7d' ? 6 : 29
  return day.getTime() - days * DAY_MS
}

function bucketStart(ts: number, granularity: StatsTrendGranularity): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  if (granularity === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  if (granularity === 'month') d.setDate(1)
  return d.getTime()
}

function nextBucket(start: number, granularity: StatsTrendGranularity): number {
  const d = new Date(start)
  if (granularity === 'day') d.setDate(d.getDate() + 1)
  else if (granularity === 'week') d.setDate(d.getDate() + 7)
  else d.setMonth(d.getMonth() + 1)
  return d.getTime()
}

function projectName(path: string | null): string {
  if (!path) return '—'
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function projectKey(path: string | null): string {
  return (path ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * Aggregates the ledger for the Usage dashboard.
 *
 * @param sqlite Open database.
 * @param query Range and trend granularity.
 * @returns Totals, per-tool / per-model / per-project breakdowns, trend and rounds.
 */
export function queryUsageLedger(
  sqlite: Database.Database,
  query: UsageLedgerQuery,
): UsageLedgerSnapshot {
  ensureUsageLedgerSchema(sqlite)
  const now = query.now ?? Date.now()
  const start = usageRangeStart(query.range, now)
  const end = now
  const granularity = query.granularity ?? (query.range === 'today' ? 'day' : 'day')
  const span = end - start + 1
  const previousStart = start - span

  const records = sqlite
    .prepare(
      `SELECT agent_type AS agentType, session_id AS sessionId, workspace_path AS workspacePath,
        model, ts, input_tokens AS input, cache_read_tokens AS cacheRead,
        cache_write_5m_tokens AS cacheWrite5m, cache_write_1h_tokens AS cacheWrite1h,
        output_tokens AS output
       FROM usage_records WHERE ts >= ? AND ts <= ?`,
    )
    .all(previousStart, end) as RecordRow[]
  const prompts = sqlite
    .prepare(
      `SELECT agent_type AS agentType, session_id AS sessionId, workspace_path AS workspacePath,
        model, ts, preview FROM usage_prompts WHERE ts >= ? AND ts <= ? ORDER BY ts`,
    )
    .all(previousStart, end) as PromptRow[]

  const totals = emptyTotals()
  const previous = emptyTotals()
  const byAgent = new Map<AgentType, UsageLedgerTotals & { sessions: Set<string> }>()
  const byModel = new Map<string, UsageLedgerTotals & { agentType: AgentType; priced: boolean }>()
  const byProject = new Map<
    string,
    UsageLedgerTotals & {
      path: string
      agents: Set<AgentType>
      sessions: Set<string>
      last: number
    }
  >()
  const sessions = new Map<string, UsageLedgerSession>()
  const trend = new Map<
    number,
    { costUsd: number; tokens: number; byAgent: Map<AgentType, number> }
  >()

  for (let b = bucketStart(start, granularity); b <= end; b = nextBucket(b, granularity)) {
    trend.set(b, { costUsd: 0, tokens: 0, byAgent: new Map() })
  }

  const sessionFor = (row: {
    agentType: AgentType
    sessionId: string
    workspacePath: string | null
    ts: number
  }): UsageLedgerSession => {
    const key = `${row.agentType}:${row.sessionId}`
    let session = sessions.get(key)
    if (!session) {
      session = {
        agentType: row.agentType,
        sessionId: row.sessionId,
        projectPath: row.workspacePath ?? '',
        projectName: projectName(row.workspacePath),
        startedAt: row.ts,
        lastActiveAt: row.ts,
        rounds: 0,
        models: [],
        tokens: 0,
        costUsd: 0,
        unpricedTokens: 0,
      }
      sessions.set(key, session)
    }
    if (!session.projectPath && row.workspacePath) {
      session.projectPath = row.workspacePath
      session.projectName = projectName(row.workspacePath)
    }
    session.startedAt = Math.min(session.startedAt, row.ts)
    session.lastActiveAt = Math.max(session.lastActiveAt, row.ts)
    return session
  }

  for (const row of records) {
    const price = findModelPrice(row.model)
    const cost = price
      ? priceRequest(price, {
          input: row.input,
          cacheRead: row.cacheRead,
          cacheWrite5m: row.cacheWrite5m,
          cacheWrite1h: row.cacheWrite1h,
          output: row.output,
        })
      : undefined
    if (row.ts < start) {
      addRecord(previous, row, cost)
      continue
    }
    addRecord(totals, row, cost)

    const agent = byAgent.get(row.agentType) ?? { ...emptyTotals(), sessions: new Set<string>() }
    addRecord(agent, row, cost)
    agent.sessions.add(row.sessionId)
    byAgent.set(row.agentType, agent)

    const modelKey = row.model ?? '—'
    const model = byModel.get(modelKey) ?? {
      ...emptyTotals(),
      agentType: row.agentType,
      priced: price !== undefined,
    }
    addRecord(model, row, cost)
    byModel.set(modelKey, model)

    const pKey = projectKey(row.workspacePath)
    const project = byProject.get(pKey) ?? {
      ...emptyTotals(),
      path: row.workspacePath ?? '',
      agents: new Set<AgentType>(),
      sessions: new Set<string>(),
      last: 0,
    }
    addRecord(project, row, cost)
    project.agents.add(row.agentType)
    project.sessions.add(`${row.agentType}:${row.sessionId}`)
    project.last = Math.max(project.last, row.ts)
    byProject.set(pKey, project)

    const session = sessionFor(row)
    const rowTokens = row.input + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h + row.output
    session.tokens += rowTokens
    if (cost === undefined) session.unpricedTokens += rowTokens
    else session.costUsd += cost

    const bucket = trend.get(bucketStart(row.ts, granularity))
    if (bucket) {
      bucket.tokens += rowTokens
      bucket.costUsd += cost ?? 0
      bucket.byAgent.set(row.agentType, (bucket.byAgent.get(row.agentType) ?? 0) + (cost ?? 0))
    }
  }

  const modelRounds = new Map<string, { sessions: Set<string>; rounds: number }>()
  for (const row of prompts) {
    if (row.ts < start) {
      previous.rounds += 1
      continue
    }
    totals.rounds += 1
    const agent = byAgent.get(row.agentType) ?? { ...emptyTotals(), sessions: new Set<string>() }
    agent.rounds += 1
    agent.sessions.add(row.sessionId)
    byAgent.set(row.agentType, agent)

    const pKey = projectKey(row.workspacePath)
    const project = byProject.get(pKey)
    if (project) project.rounds += 1

    const session = sessionFor(row)
    session.rounds += 1
    if (!session.title && row.preview) session.title = row.preview
    const model = row.model ?? '—'
    const entry = session.models.find((m) => m.model === model)
    if (entry) entry.rounds += 1
    else session.models.push({ model, rounds: 1 })

    const byModelEntry = byModel.get(model)
    if (byModelEntry) byModelEntry.rounds += 1
    const mr = modelRounds.get(model) ?? { sessions: new Set<string>(), rounds: 0 }
    mr.rounds += 1
    mr.sessions.add(`${row.agentType}:${row.sessionId}`)
    modelRounds.set(model, mr)
  }

  const sessionList = [...sessions.values()]
  const projectCount = new Set([...byProject.keys()].filter((k) => k)).size

  return {
    rangePreset: query.range,
    rangeStart: start,
    rangeEnd: end,
    generatedAt: now,
    pricingAsOf: PRICING_AS_OF,
    totals: { ...totals, sessions: sessionList.length, projects: projectCount },
    previous,
    byAgent: [...byAgent.entries()]
      .map(([agentType, t]) => {
        const { sessions: agentSessions, ...rest } = t
        return { ...rest, agentType, sessions: agentSessions.size }
      })
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    byModel: [...byModel.entries()]
      .map(([model, t]) => ({ ...t, model }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    byProject: [...byProject.values()]
      .map(({ agents, sessions: s, last, path, ...rest }) => ({
        ...rest,
        path,
        name: projectName(path),
        agents: [...agents],
        sessions: s.size,
        lastActiveAt: last,
      }))
      .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    trend: [...trend.entries()].map(([bucketStartAt, b]) => ({
      bucketStart: bucketStartAt,
      costUsd: b.costUsd,
      tokens: b.tokens,
      byAgent: Object.fromEntries(b.byAgent) as Partial<Record<AgentType, number>>,
    })),
    sessions: sessionList
      .filter((s) => s.rounds > 0)
      .sort((a, b) => b.rounds - a.rounds || b.costUsd - a.costUsd)
      .slice(0, SESSION_LIMIT)
      .map((s) => ({ ...s, models: s.models.sort((a, b) => b.rounds - a.rounds) })),
    modelRounds: [...modelRounds.entries()]
      .map(([model, m]) => ({
        model,
        rounds: m.rounds,
        sessions: m.sessions.size,
        avgRounds: m.sessions.size ? m.rounds / m.sessions.size : 0,
      }))
      .sort((a, b) => b.rounds - a.rounds),
  }
}

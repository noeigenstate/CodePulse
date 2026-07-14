/**
 * 本地使用统计聚合 —— 从 SQLite 的 events / turns / token_snapshots
 * 汇总后台大屏所需指标（仅本机，不上传）。
 *
 * @module storage/stats
 */
import { and, desc, gte, lt } from 'drizzle-orm'
import type {
  StatsCategoryShare,
  StatsDelta,
  StatsDialogBucket,
  StatsEfficiencyScore,
  StatsHeatCell,
  StatsInsight,
  StatsKpis,
  StatsModelShare,
  StatsProjectRank,
  StatsRangePreset,
  StatsTrendGranularity,
  StatsTrendPoint,
  UsageStatsQuery,
  UsageStatsSnapshot,
} from '@codepulse/shared'
import type { DB } from './sqlite/db.js'
import { events, sessions, tokenSnapshots, turns } from './sqlite/schema.js'

const MS_DAY = 24 * 60 * 60_000
const MAX_TURN_MS = 4 * 60 * 60_000

interface RangeBounds {
  start: number
  end: number
  preset: StatsRangePreset
  dayCount: number
}

export interface QueryUsageStatsOptions {
  /** 本机库路径，仅写入快照供排查。 */
  dbPath?: string
  /** 打开库失败原因。 */
  openError?: string
}

/**
 * 查询本地使用统计快照。
 *
 * @param db Drizzle 句柄；为 null 时返回空快照（persistenceAvailable=false）。
 * @param query 范围与粒度。
 * @param now 可选当前时间（测试可注入）。
 * @param options 持久化诊断字段。
 */
export function queryUsageStats(
  db: DB | null,
  query: UsageStatsQuery = {},
  now = Date.now(),
  options: QueryUsageStatsOptions = {},
): UsageStatsSnapshot {
  const range = resolveRange(query, now)
  const empty = emptySnapshot(range, now, {
    persistenceAvailable: Boolean(db),
    dbPath: options.dbPath,
    persistenceError: db ? undefined : (options.openError ?? 'SQLite unavailable'),
  })
  if (!db) return empty

  try {
    const started = Date.now()
    const current = collectPeriod(db, range.start, range.end, now)
    const prevStart = range.start - (range.end - range.start)
    const previous = collectPeriod(db, prevStart, range.start, now)

    const granularity = query.granularity ?? 'day'
    const trends = buildTrends(db, range.start, range.end, granularity, now)
    const models = buildModelShares(db, range.start, range.end)
    const projectRank = buildProjectRank(db, range.start, range.end, now)
    const heatmap = buildHeatmap(db, range.start, range.end)
    const heatmapMax = heatmap.reduce((m, c) => Math.max(m, c.value), 0)
    const projectTypes = classifyProjects(projectRank)
    const fileTypes = buildFileTypes(db, range.start, range.end)
    const dialogTokenBuckets = buildDialogBuckets(db, range.start, range.end)
    const efficiency = buildEfficiency(current, previous)
    const insights = buildInsights(current, models, heatmap, heatmapMax, range)
    const kpis = buildKpis(current, previous, range.dayCount)

    const elapsed = Date.now() - started
    if (elapsed > 2_000) {
      console.warn(`[codepulse] queryUsageStats took ${elapsed}ms`)
    }

    return {
      rangeStart: range.start,
      rangeEnd: range.end,
      rangePreset: range.preset,
      generatedAt: now,
      hasData: current.eventCount > 0 || current.dialogCount > 0 || current.totalTokens > 0,
      persistenceAvailable: true,
      dbPath: options.dbPath,
      kpis,
      tokenTrend: trends,
      durationTrend: trends,
      models,
      projectRank,
      insights,
      projectTypes,
      fileTypes,
      dialogTokenBuckets,
      heatmap,
      heatmapMax,
      efficiency,
    }
  } catch (err) {
    console.error('[codepulse] queryUsageStats failed', err)
    const message = err instanceof Error ? err.message : String(err)
    return emptySnapshot(range, now, {
      persistenceAvailable: true,
      dbPath: options.dbPath,
      persistenceError: message,
    })
  }
}

interface PeriodMetrics {
  totalTokens: number
  totalDurationMs: number
  projectCount: number
  dialogCount: number
  eventCount: number
  completedDialogs: number
  avgDialogTokens: number
  peakDayLabel?: string
  peakDayTokens: number
}

function collectPeriod(db: DB, start: number, end: number, now: number): PeriodMetrics {
  const tokenRows = db
    .select({
      sessionId: tokenSnapshots.sessionId,
      total: tokenSnapshots.totalTokens,
      input: tokenSnapshots.inputTokens,
      output: tokenSnapshots.outputTokens,
      turnId: tokenSnapshots.turnId,
    })
    .from(tokenSnapshots)
    .where(and(gte(tokenSnapshots.capturedAt, start), lt(tokenSnapshots.capturedAt, end)))
    .all()

  // 优先按 turn 取峰值，否则按 session 取峰值（累计型上下文用量）
  const byTurn = new Map<string, number>()
  const bySession = new Map<string, number>()
  for (const row of tokenRows) {
    const n = effectiveTokens(row.total, row.input, row.output)
    if (n <= 0) continue
    if (row.turnId) {
      byTurn.set(row.turnId, Math.max(byTurn.get(row.turnId) ?? 0, n))
    } else {
      bySession.set(row.sessionId, Math.max(bySession.get(row.sessionId) ?? 0, n))
    }
  }
  let totalTokens = 0
  for (const v of byTurn.values()) totalTokens += v
  for (const v of bySession.values()) totalTokens += v

  const turnRows = db
    .select({
      startedAt: turns.startedAt,
      endedAt: turns.endedAt,
      state: turns.state,
    })
    .from(turns)
    .where(and(gte(turns.startedAt, start), lt(turns.startedAt, end)))
    .all()

  let totalDurationMs = 0
  let completedDialogs = 0
  for (const turn of turnRows) {
    const endAt = turn.endedAt ?? (isOpenState(turn.state) ? now : turn.startedAt)
    const dur = Math.min(MAX_TURN_MS, Math.max(0, endAt - turn.startedAt))
    totalDurationMs += dur
    if (turn.endedAt && (turn.state === 'DONE' || turn.state === 'done')) completedDialogs += 1
    else if (turn.endedAt) completedDialogs += 1
  }
  const dialogCount = turnRows.length

  const projectRows = db
    .select({
      path: events.workspacePath,
    })
    .from(events)
    .where(and(gte(events.timestamp, start), lt(events.timestamp, end)))
    .all()

  const projects = new Set<string>()
  for (const row of projectRows) {
    const p = normalizePath(row.path)
    if (p) projects.add(p)
  }

  const eventCount = projectRows.length
  const avgDialogTokens = dialogCount > 0 ? totalTokens / dialogCount : 0

  // peak day for insights
  const dayTokens = new Map<string, number>()
  const snapDays = db
    .select({
      capturedAt: tokenSnapshots.capturedAt,
      total: tokenSnapshots.totalTokens,
      input: tokenSnapshots.inputTokens,
      output: tokenSnapshots.outputTokens,
      sessionId: tokenSnapshots.sessionId,
      turnId: tokenSnapshots.turnId,
    })
    .from(tokenSnapshots)
    .where(and(gte(tokenSnapshots.capturedAt, start), lt(tokenSnapshots.capturedAt, end)))
    .all()
  const daySessionMax = new Map<string, number>()
  for (const row of snapDays) {
    const day = localDayKey(row.capturedAt)
    const key = `${day}|${row.turnId ?? row.sessionId}`
    const n = effectiveTokens(row.total, row.input, row.output)
    daySessionMax.set(key, Math.max(daySessionMax.get(key) ?? 0, n))
  }
  for (const [key, n] of daySessionMax) {
    const day = key.split('|')[0]!
    dayTokens.set(day, (dayTokens.get(day) ?? 0) + n)
  }
  let peakDayLabel: string | undefined
  let peakDayTokens = 0
  for (const [day, n] of dayTokens) {
    if (n > peakDayTokens) {
      peakDayTokens = n
      peakDayLabel = day
    }
  }

  return {
    totalTokens,
    totalDurationMs,
    projectCount: projects.size,
    dialogCount,
    eventCount,
    completedDialogs,
    avgDialogTokens,
    peakDayLabel,
    peakDayTokens,
  }
}

function buildTrends(
  db: DB,
  start: number,
  end: number,
  granularity: StatsTrendGranularity,
  now: number,
): StatsTrendPoint[] {
  const buckets = makeBuckets(start, end, granularity)
  if (buckets.length === 0) return []

  const snapRows = db
    .select({
      capturedAt: tokenSnapshots.capturedAt,
      total: tokenSnapshots.totalTokens,
      input: tokenSnapshots.inputTokens,
      output: tokenSnapshots.outputTokens,
      sessionId: tokenSnapshots.sessionId,
      turnId: tokenSnapshots.turnId,
    })
    .from(tokenSnapshots)
    .where(and(gte(tokenSnapshots.capturedAt, start), lt(tokenSnapshots.capturedAt, end)))
    .all()

  const tokenByBucket = new Map<number, number>()
  const unitMax = new Map<string, number>()
  for (const row of snapRows) {
    const b = bucketStartFor(row.capturedAt, start, granularity)
    const unit = `${b}|${row.turnId ?? row.sessionId}`
    const n = effectiveTokens(row.total, row.input, row.output)
    unitMax.set(unit, Math.max(unitMax.get(unit) ?? 0, n))
  }
  for (const [unit, n] of unitMax) {
    const b = Number(unit.split('|')[0])
    if (!Number.isFinite(b)) continue
    tokenByBucket.set(b, (tokenByBucket.get(b) ?? 0) + n)
  }

  const turnRows = db
    .select({
      startedAt: turns.startedAt,
      endedAt: turns.endedAt,
      state: turns.state,
    })
    .from(turns)
    .where(and(gte(turns.startedAt, start), lt(turns.startedAt, end)))
    .all()

  const durationByBucket = new Map<number, number>()
  const dialogsByBucket = new Map<number, number>()
  for (const turn of turnRows) {
    const b = bucketStartFor(turn.startedAt, start, granularity)
    const endAt = turn.endedAt ?? (isOpenState(turn.state) ? now : turn.startedAt)
    const dur = Math.min(MAX_TURN_MS, Math.max(0, endAt - turn.startedAt))
    durationByBucket.set(b, (durationByBucket.get(b) ?? 0) + dur)
    dialogsByBucket.set(b, (dialogsByBucket.get(b) ?? 0) + 1)
  }

  return buckets.map((bucketStart) => ({
    bucketStart,
    label: formatBucketLabel(bucketStart, granularity),
    tokens: tokenByBucket.get(bucketStart) ?? 0,
    durationMs: durationByBucket.get(bucketStart) ?? 0,
    dialogs: dialogsByBucket.get(bucketStart) ?? 0,
  }))
}

function buildModelShares(db: DB, start: number, end: number): StatsModelShare[] {
  const rows = db
    .select({
      model: sessions.model,
      sessionId: sessions.id,
    })
    .from(sessions)
    .where(and(gte(sessions.startedAt, start), lt(sessions.startedAt, end)))
    .all()

  const tokenBySession = sessionTokenPeaks(db, start, end)
  const byModel = new Map<string, number>()
  for (const row of rows) {
    const model = normalizeModel(row.model)
    const tokens = tokenBySession.get(row.sessionId) ?? 1
    byModel.set(model, (byModel.get(model) ?? 0) + tokens)
  }

  // 若会话无 model，回退到事件 model
  if (byModel.size === 0) {
    const eventModels = db
      .select({ model: events.model })
      .from(events)
      .where(and(gte(events.timestamp, start), lt(events.timestamp, end)))
      .all()
    for (const row of eventModels) {
      if (!row.model) continue
      const model = normalizeModel(row.model)
      byModel.set(model, (byModel.get(model) ?? 0) + 1)
    }
  }

  const total = [...byModel.values()].reduce((a, b) => a + b, 0) || 1
  return [...byModel.entries()]
    .map(([model, tokens]) => ({
      model,
      tokens,
      percent: Math.round((tokens / total) * 1000) / 10,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 8)
}

function sessionTokenPeaks(db: DB, start: number, end: number): Map<string, number> {
  const rows = db
    .select({
      sessionId: tokenSnapshots.sessionId,
      total: tokenSnapshots.totalTokens,
      input: tokenSnapshots.inputTokens,
      output: tokenSnapshots.outputTokens,
    })
    .from(tokenSnapshots)
    .where(and(gte(tokenSnapshots.capturedAt, start), lt(tokenSnapshots.capturedAt, end)))
    .all()
  const map = new Map<string, number>()
  for (const row of rows) {
    const n = effectiveTokens(row.total, row.input, row.output)
    map.set(row.sessionId, Math.max(map.get(row.sessionId) ?? 0, n))
  }
  return map
}

function buildProjectRank(db: DB, start: number, end: number, now: number): StatsProjectRank[] {
  const eventRows = db
    .select({
      path: events.workspacePath,
      timestamp: events.timestamp,
      eventType: events.eventType,
      externalSessionId: events.externalSessionId,
      model: events.model,
    })
    .from(events)
    .where(and(gte(events.timestamp, start), lt(events.timestamp, end)))
    .all()

  interface Acc {
    path: string
    name: string
    dialogs: number
    lastActiveAt: number
    sessions: Set<string>
  }
  const byPath = new Map<string, Acc>()
  for (const row of eventRows) {
    const path = normalizePath(row.path)
    if (!path) continue
    let acc = byPath.get(path)
    if (!acc) {
      acc = {
        path,
        name: basename(path),
        dialogs: 0,
        lastActiveAt: 0,
        sessions: new Set(),
      }
      byPath.set(path, acc)
    }
    acc.lastActiveAt = Math.max(acc.lastActiveAt, row.timestamp)
    if (row.eventType === 'prompt_submit') acc.dialogs += 1
    if (row.externalSessionId) acc.sessions.add(row.externalSessionId)
  }

  // 会话 token → 按事件中的 external_session 映射到 path
  const sessionPath = new Map<string, string>()
  for (const row of eventRows) {
    const path = normalizePath(row.path)
    if (!path || !row.externalSessionId) continue
    if (!sessionPath.has(row.externalSessionId)) sessionPath.set(row.externalSessionId, path)
  }

  const sessionRows = db
    .select({
      id: sessions.id,
      externalSessionId: sessions.externalSessionId,
    })
    .from(sessions)
    .where(and(gte(sessions.startedAt, start), lt(sessions.startedAt, end)))
    .all()

  const tokenPeaks = sessionTokenPeaks(db, start, end)
  const tokensByPath = new Map<string, number>()
  for (const s of sessionRows) {
    const path = sessionPath.get(s.externalSessionId)
    if (!path) continue
    tokensByPath.set(path, (tokensByPath.get(path) ?? 0) + (tokenPeaks.get(s.id) ?? 0))
  }

  // 时长：按 path 关联 turn 较难；用 prompt_submit 到下一 stop 的粗估
  // 简化：按 dialog 占比分摊总时长
  const turnRows = db
    .select({
      startedAt: turns.startedAt,
      endedAt: turns.endedAt,
      state: turns.state,
      sessionId: turns.sessionId,
    })
    .from(turns)
    .where(and(gte(turns.startedAt, start), lt(turns.startedAt, end)))
    .all()

  const sessionIdToExternal = new Map(sessionRows.map((s) => [s.id, s.externalSessionId]))
  const durationByPath = new Map<string, number>()
  for (const turn of turnRows) {
    const ext = sessionIdToExternal.get(turn.sessionId)
    const path = ext ? sessionPath.get(ext) : undefined
    if (!path) continue
    const endAt = turn.endedAt ?? (isOpenState(turn.state) ? now : turn.startedAt)
    const dur = Math.min(MAX_TURN_MS, Math.max(0, endAt - turn.startedAt))
    durationByPath.set(path, (durationByPath.get(path) ?? 0) + dur)
  }

  const totalTokens = [...tokensByPath.values()].reduce((a, b) => a + b, 0) || 1
  const ranks: StatsProjectRank[] = []
  for (const acc of byPath.values()) {
    const tokens = tokensByPath.get(acc.path) ?? 0
    const dialogCount = acc.dialogs || acc.sessions.size
    ranks.push({
      name: acc.name,
      path: acc.path,
      tokens,
      tokenShare: Math.round((tokens / totalTokens) * 1000) / 10,
      durationMs: durationByPath.get(acc.path) ?? 0,
      dialogCount,
      lastActiveAt: acc.lastActiveAt,
    })
  }

  return ranks.sort((a, b) => b.tokens - a.tokens || b.dialogCount - a.dialogCount).slice(0, 12)
}

function buildHeatmap(db: DB, start: number, end: number): StatsHeatCell[] {
  const rows = db
    .select({ timestamp: events.timestamp })
    .from(events)
    .where(and(gte(events.timestamp, start), lt(events.timestamp, end)))
    .all()

  const grid = new Map<string, number>()
  for (const row of rows) {
    const d = new Date(row.timestamp)
    // 周一=0 … 周日=6
    const weekday = (d.getDay() + 6) % 7
    const hour = d.getHours()
    const key = `${weekday}:${hour}`
    grid.set(key, (grid.get(key) ?? 0) + 1)
  }

  const cells: StatsHeatCell[] = []
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      cells.push({
        weekday,
        hour,
        value: grid.get(`${weekday}:${hour}`) ?? 0,
      })
    }
  }
  return cells
}

function buildFileTypes(db: DB, start: number, end: number): StatsCategoryShare[] {
  // 仅用 tool 相关短字段，避免把 message 全文扫进内存（大库上会导致统计卡住/失败）。
  // 取最近一批即可反映分布，不必全量扫描。
  const rows = db
    .select({
      toolName: events.toolName,
      command: events.command,
    })
    .from(events)
    .where(and(gte(events.timestamp, start), lt(events.timestamp, end)))
    .orderBy(desc(events.timestamp))
    .limit(8_000)
    .all()

  const counts = new Map<string, number>()
  const extRe = /\.([a-zA-Z0-9]{1,8})\b/g
  for (const row of rows) {
    if (!row.toolName && !row.command) continue
    const text = `${row.toolName ?? ''} ${row.command ?? ''}`
    let match: RegExpExecArray | null
    const seen = new Set<string>()
    while ((match = extRe.exec(text)) !== null) {
      const ext = match[1]!.toLowerCase()
      const key = mapExtension(ext)
      if (!key || seen.has(key)) continue
      seen.add(key)
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }

  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  if (total === 0) return []

  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      labelKey: key,
      count,
      percent: Math.round((count / total) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)
}

function mapExtension(ext: string): string | undefined {
  if (['py', 'pyi', 'ipynb'].includes(ext)) return 'Python'
  if (['md', 'mdx', 'rst'].includes(ext)) return 'Markdown'
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(ext)) return 'JavaScript'
  if (['json', 'jsonc'].includes(ext)) return 'JSON'
  if (['go', 'rs', 'java', 'kt', 'cs', 'cpp', 'c', 'h'].includes(ext)) return 'Other'
  if (['yml', 'yaml', 'toml', 'xml', 'html', 'css', 'scss'].includes(ext)) return 'Other'
  return undefined
}

function classifyProjects(ranks: StatsProjectRank[]): StatsCategoryShare[] {
  if (ranks.length === 0) return []
  const buckets = {
    tool: 0,
    research: 0,
    web: 0,
    other: 0,
  }
  for (const p of ranks) {
    const name = `${p.name} ${p.path}`.toLowerCase()
    if (/(web|app|frontend|next|react|vue|site|ui)/.test(name)) buckets.web += 1
    else if (/(research|experiment|lab|paper|study|demo|poc)/.test(name)) buckets.research += 1
    else if (/(tool|script|cli|hook|util|pipeline|bot|agent)/.test(name)) buckets.tool += 1
    else buckets.other += 1
  }
  const total = ranks.length
  const entries: StatsCategoryShare[] = [
    { key: 'tool', labelKey: 'projectTypeTool', count: buckets.tool, percent: 0 },
    { key: 'research', labelKey: 'projectTypeResearch', count: buckets.research, percent: 0 },
    { key: 'web', labelKey: 'projectTypeWeb', count: buckets.web, percent: 0 },
    { key: 'other', labelKey: 'projectTypeOther', count: buckets.other, percent: 0 },
  ]
  return entries
    .filter((e) => e.count > 0)
    .map((e) => ({ ...e, percent: Math.round((e.count / total) * 1000) / 10 }))
    .sort((a, b) => b.count - a.count)
}

function buildDialogBuckets(db: DB, start: number, end: number): StatsDialogBucket[] {
  const rows = db
    .select({
      turnId: tokenSnapshots.turnId,
      sessionId: tokenSnapshots.sessionId,
      total: tokenSnapshots.totalTokens,
      input: tokenSnapshots.inputTokens,
      output: tokenSnapshots.outputTokens,
    })
    .from(tokenSnapshots)
    .where(and(gte(tokenSnapshots.capturedAt, start), lt(tokenSnapshots.capturedAt, end)))
    .all()

  const peaks = new Map<string, number>()
  for (const row of rows) {
    const key = row.turnId ?? row.sessionId
    const n = effectiveTokens(row.total, row.input, row.output)
    peaks.set(key, Math.max(peaks.get(key) ?? 0, n))
  }

  const defs: { key: string; labelKey: string; min: number; max: number }[] = [
    { key: '0-500', labelKey: 'bucket0_500', min: 0, max: 500 },
    { key: '500-2k', labelKey: 'bucket500_2k', min: 500, max: 2000 },
    { key: '2k-5k', labelKey: 'bucket2k_5k', min: 2000, max: 5000 },
    { key: '5k-10k', labelKey: 'bucket5k_10k', min: 5000, max: 10_000 },
    { key: '10k+', labelKey: 'bucket10k_plus', min: 10_000, max: Infinity },
  ]
  const counts = new Map(defs.map((d) => [d.key, 0]))
  for (const n of peaks.values()) {
    const def = defs.find((d) => n >= d.min && n < d.max) ?? defs[defs.length - 1]!
    counts.set(def.key, (counts.get(def.key) ?? 0) + 1)
  }
  return defs.map((d) => ({
    key: d.key,
    labelKey: d.labelKey,
    count: counts.get(d.key) ?? 0,
  }))
}

function buildEfficiency(current: PeriodMetrics, previous: PeriodMetrics): StatsEfficiencyScore {
  const completionRate =
    current.dialogCount > 0 ? current.completedDialogs / current.dialogCount : 0.5
  const avgMs = current.dialogCount > 0 ? current.totalDurationMs / current.dialogCount : 0
  // 越接近 8–25 分钟越好
  const ideal = 15 * 60_000
  const durationScore =
    avgMs <= 0 ? 70 : Math.max(40, Math.min(100, 100 - (Math.abs(avgMs - ideal) / ideal / 2) * 100))
  const codeGen = Math.round(55 + completionRate * 40)
  const problemSolve = Math.round(durationScore)
  const dialogQuality = Math.round(
    Math.min(
      100,
      50 + (current.avgDialogTokens > 0 ? Math.min(40, current.avgDialogTokens / 500) : 20),
    ),
  )
  const focus = Math.round(
    Math.min(
      100,
      50 +
        Math.min(
          40,
          (current.projectCount > 0 ? 30 / Math.max(1, current.projectCount) : 0) +
            completionRate * 30,
        ),
    ),
  )
  const score = Math.round((codeGen + problemSolve + dialogQuality + focus) / 4)
  const grade = score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 55 ? 'fair' : 'low'

  const prevScore =
    previous.dialogCount + previous.eventCount > 0
      ? Math.round(
          (55 +
            (previous.dialogCount > 0 ? previous.completedDialogs / previous.dialogCount : 0.5) *
              40 +
            70 +
            70 +
            70) /
            4,
        )
      : undefined

  return {
    score,
    grade,
    codeGen,
    problemSolve,
    dialogQuality,
    focus,
    delta: makeAbsoluteDelta(score, prevScore),
  }
}

function buildInsights(
  current: PeriodMetrics,
  models: StatsModelShare[],
  heatmap: StatsHeatCell[],
  heatmapMax: number,
  range: RangeBounds,
): StatsInsight[] {
  const insights: StatsInsight[] = []

  if (current.peakDayLabel && current.peakDayTokens > 0) {
    insights.push({
      id: 'peak_day',
      kind: 'peak_day',
      titleKey: 'insightPeakDay',
      detailKey: 'insightPeakDayDetail',
      params: {
        day: formatDayLabel(current.peakDayLabel),
        tokens: current.peakDayTokens,
      },
    })
  }

  if (models[0]) {
    insights.push({
      id: 'top_model',
      kind: 'top_model',
      titleKey: 'insightTopModel',
      detailKey: 'insightTopModelDetail',
      params: {
        model: models[0].model,
        percent: models[0].percent,
      },
    })
  }

  if (current.dialogCount > 0) {
    insights.push({
      id: 'efficiency',
      kind: 'efficiency',
      titleKey: 'insightEfficiency',
      detailKey: 'insightEfficiencyDetail',
      params: {
        avgTokens: Math.round(current.avgDialogTokens),
      },
    })
  }

  if (heatmapMax > 0) {
    let best = heatmap[0]!
    for (const cell of heatmap) {
      if (cell.value > best.value) best = cell
    }
    if (best.value > 0) {
      insights.push({
        id: 'peak_hour',
        kind: 'info',
        titleKey: 'insightPeakHour',
        detailKey: 'insightPeakHourDetail',
        params: {
          weekday: best.weekday,
          hour: best.hour,
          value: best.value,
        },
      })
    }
  }

  if (insights.length === 0) {
    insights.push({
      id: 'empty',
      kind: 'info',
      titleKey: 'insightEmpty',
      detailKey: 'insightEmptyDetail',
      params: { days: range.dayCount },
    })
  }

  return insights.slice(0, 4)
}

function buildKpis(current: PeriodMetrics, previous: PeriodMetrics, dayCount: number): StatsKpis {
  const days = Math.max(1, dayCount)
  return {
    totalTokens: current.totalTokens,
    totalDurationMs: current.totalDurationMs,
    projectCount: current.projectCount,
    dialogCount: current.dialogCount,
    avgDailyTokens: Math.round(current.totalTokens / days),
    avgDailyDurationMs: Math.round(current.totalDurationMs / days),
    deltas: {
      totalTokens: makeRatioDelta(current.totalTokens, previous.totalTokens),
      totalDurationMs: makeRatioDelta(current.totalDurationMs, previous.totalDurationMs),
      projectCount: makeAbsoluteDelta(current.projectCount, previous.projectCount),
      dialogCount: makeRatioDelta(current.dialogCount, previous.dialogCount),
      avgDailyTokens: makeRatioDelta(current.totalTokens / days, previous.totalTokens / days),
      avgDailyDurationMs: makeRatioDelta(
        current.totalDurationMs / days,
        previous.totalDurationMs / days,
      ),
    },
  }
}

function makeRatioDelta(current: number, previous: number): StatsDelta {
  if (previous <= 0) {
    return {
      comparable: current > 0,
      ratio: current > 0 ? 1 : undefined,
      absolute: current - previous,
    }
  }
  return {
    comparable: true,
    ratio: (current - previous) / previous,
    absolute: current - previous,
  }
}

function makeAbsoluteDelta(current: number, previous: number | undefined): StatsDelta {
  if (previous == null) return { comparable: false }
  return {
    comparable: true,
    absolute: current - previous,
    ratio: previous === 0 ? (current > 0 ? 1 : 0) : (current - previous) / Math.abs(previous),
  }
}

function resolveRange(query: UsageStatsQuery, now: number): RangeBounds {
  if (typeof query.start === 'number' && typeof query.end === 'number' && query.end > query.start) {
    const dayCount = Math.max(1, Math.ceil((query.end - query.start) / MS_DAY))
    return {
      start: query.start,
      end: query.end,
      preset: query.range ?? '7d',
      dayCount,
    }
  }

  const preset: StatsRangePreset = query.range ?? '7d'
  const end = endOfLocalDay(now) + 1
  if (preset === 'today') {
    const start = startOfLocalDay(now)
    return { start, end, preset, dayCount: 1 }
  }
  if (preset === '30d') {
    const start = startOfLocalDay(now - 29 * MS_DAY)
    return { start, end, preset, dayCount: 30 }
  }
  const start = startOfLocalDay(now - 6 * MS_DAY)
  return { start, end, preset, dayCount: 7 }
}

function emptySnapshot(
  range: RangeBounds,
  now: number,
  meta: {
    persistenceAvailable: boolean
    dbPath?: string
    persistenceError?: string
  } = { persistenceAvailable: false },
): UsageStatsSnapshot {
  const emptyDelta: StatsDelta = { comparable: false }
  const zeroKpis: StatsKpis = {
    totalTokens: 0,
    totalDurationMs: 0,
    projectCount: 0,
    dialogCount: 0,
    avgDailyTokens: 0,
    avgDailyDurationMs: 0,
    deltas: {
      totalTokens: emptyDelta,
      totalDurationMs: emptyDelta,
      projectCount: emptyDelta,
      dialogCount: emptyDelta,
      avgDailyTokens: emptyDelta,
      avgDailyDurationMs: emptyDelta,
    },
  }
  return {
    rangeStart: range.start,
    rangeEnd: range.end,
    rangePreset: range.preset,
    generatedAt: now,
    hasData: false,
    persistenceAvailable: meta.persistenceAvailable,
    dbPath: meta.dbPath,
    persistenceError: meta.persistenceError,
    kpis: zeroKpis,
    tokenTrend: makeBuckets(range.start, range.end, 'day').map((bucketStart) => ({
      bucketStart,
      label: formatBucketLabel(bucketStart, 'day'),
      tokens: 0,
      durationMs: 0,
      dialogs: 0,
    })),
    durationTrend: [],
    models: [],
    projectRank: [],
    insights: [
      {
        id: 'empty',
        kind: 'info',
        titleKey: 'insightEmpty',
        detailKey: 'insightEmptyDetail',
        params: { days: range.dayCount },
      },
    ],
    projectTypes: [],
    fileTypes: [],
    dialogTokenBuckets: [
      { key: '0-500', labelKey: 'bucket0_500', count: 0 },
      { key: '500-2k', labelKey: 'bucket500_2k', count: 0 },
      { key: '2k-5k', labelKey: 'bucket2k_5k', count: 0 },
      { key: '5k-10k', labelKey: 'bucket5k_10k', count: 0 },
      { key: '10k+', labelKey: 'bucket10k_plus', count: 0 },
    ],
    heatmap: Array.from({ length: 7 * 24 }, (_, i) => ({
      weekday: Math.floor(i / 24),
      hour: i % 24,
      value: 0,
    })),
    heatmapMax: 0,
    efficiency: {
      score: 0,
      grade: 'low',
      codeGen: 0,
      problemSolve: 0,
      dialogQuality: 0,
      focus: 0,
      delta: emptyDelta,
    },
  }
}

function makeBuckets(start: number, end: number, granularity: StatsTrendGranularity): number[] {
  const buckets: number[] = []
  if (granularity === 'day') {
    let t = startOfLocalDay(start)
    while (t < end) {
      buckets.push(t)
      t += MS_DAY
    }
    return buckets
  }
  if (granularity === 'week') {
    let t = startOfLocalWeek(start)
    while (t < end) {
      buckets.push(t)
      t += 7 * MS_DAY
    }
    return buckets
  }
  // month
  let d = new Date(start)
  d = new Date(d.getFullYear(), d.getMonth(), 1)
  while (d.getTime() < end) {
    buckets.push(d.getTime())
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  }
  return buckets
}

function bucketStartFor(
  ts: number,
  _rangeStart: number,
  granularity: StatsTrendGranularity,
): number {
  if (granularity === 'day') return startOfLocalDay(ts)
  if (granularity === 'week') return startOfLocalWeek(ts)
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

function formatBucketLabel(ts: number, granularity: StatsTrendGranularity): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  if (granularity === 'month') return `${d.getFullYear()}-${mm}`
  if (granularity === 'week') return `${mm}-${dd}`
  return `${mm}-${dd}`
}

function formatDayLabel(dayKey: string): string {
  // YYYY-MM-DD → MM-DD（周X）
  const parts = dayKey.split('-')
  if (parts.length !== 3) return dayKey
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${parts[1]}-${parts[2]}（周${weekdays[d.getDay()]}）`
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function endOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(23, 59, 59, 999)
  return d.getTime()
}

function startOfLocalWeek(ts: number): number {
  const d = new Date(startOfLocalDay(ts))
  const day = (d.getDay() + 6) % 7 // Mon=0
  d.setDate(d.getDate() - day)
  return d.getTime()
}

function localDayKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function effectiveTokens(
  total: number | null | undefined,
  input: number | null | undefined,
  output: number | null | undefined,
): number {
  if (typeof total === 'number' && total > 0) return total
  const sum = (input ?? 0) + (output ?? 0)
  return sum > 0 ? sum : 0
}

function isOpenState(state: string): boolean {
  return [
    'PROMPT_SUBMITTED',
    'THINKING',
    'TOOL_RUNNING',
    'WAITING_PERMISSION',
    'WAITING_USER_INPUT',
    'running',
  ].includes(state)
}

function normalizePath(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  return trimmed || undefined
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path
}

function normalizeModel(model: string | null | undefined): string {
  if (!model || !model.trim()) return '其他'
  const m = model.trim()
  // 缩短常见长名
  if (/claude.*3\.5|claude-3-5|claude-3\.5/i.test(m)) return 'Claude-3.5'
  if (/claude.*4|claude-sonnet-4|claude-opus-4/i.test(m))
    return m.replace(/^.*?(claude[^/\s]*)/i, '$1')
  if (/gpt-4o/i.test(m)) return 'GPT-4o'
  if (/gpt-5/i.test(m)) return m.length > 24 ? 'GPT-5' : m
  if (/gemini/i.test(m)) return m.length > 20 ? 'Gemini' : m
  if (/o[1-4]/i.test(m)) return m
  return m.length > 28 ? `${m.slice(0, 26)}…` : m
}

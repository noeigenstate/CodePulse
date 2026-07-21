import {
  TurnState,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type TokenQuotaBucket,
  normalizeWorkspacePath,
  workspaceKey,
} from '@codepulse/shared'
import { visibleRateLimitWindows } from './panelFormat.js'

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex', 'grok', 'kimi']
const QUOTA_RECENCY_WINDOW_MS = 30 * 60_000

/** 人类可读的 agent 显示名称。 */
export function agentDisplayName(agentType: AgentType): string {
  if (agentType === 'codex') return 'Codex'
  if (agentType === 'grok') return 'Grok'
  if (agentType === 'kimi') return 'Kimi Code'
  return 'Claude Code'
}

export interface WorkspaceAgentGroup {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  token?: TokenPayload
  agents: AgentRuntimeState[]
}

export interface AgentWorkspaceItem {
  id: string
  name: string
  workspacePath?: string
  updatedAt: number
  agent: AgentRuntimeState
}

export interface AgentPanel {
  agentType: AgentType
  name: string
  updatedAt: number
  /** Preferred single bucket (active model); kept for callers that only need one. */
  quotaToken?: TokenPayload
  /** All quota meters to render for this pane (Codex may stack weekly + Spark). */
  quotaMeters: QuotaMeterSource[]
  workspaces: AgentWorkspaceItem[]
}

/** One rate-limit bar source (usually a Codex quota bucket). */
export interface QuotaMeterSource {
  id: string
  token: TokenPayload
  updatedAt: number
}

interface QuotaCandidate {
  agent: AgentRuntimeState
  token: TokenPayload
  updatedAt: number
}

export function buildDisplayAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  return (
    buildWorkspaceAgentGroups(visibleTaskAgents(agents))[0]?.agents ??
    DISPLAY_AGENT_ORDER.map((type) => idleAgent(type))
  )
}

/**
 * 按 agent 类型构建 Dashboard 分屏。
 * 仅在该 CLI 已有可见任务/项目或额度数据时返回对应分屏（自适应 1～3 栏）。
 * 项目行被隐藏后仍会保留额度条，直到该 agent 状态槽位被清理。
 */
export function buildAgentPanels(agents: AgentRuntimeState[]): AgentPanel[] {
  return DISPLAY_AGENT_ORDER.flatMap((agentType) => {
    const typeAgents = agents.filter((agent) => agent.agentType === agentType)
    if (typeAgents.length === 0) return []

    const workspaces = buildAgentWorkspaceItems(agentType, visibleTaskAgents(typeAgents))
    const preferredModel = preferredQuotaModel(typeAgents)
    const quotaMeters = collectQuotaMeters(typeAgents, agentType)
    const quotaToken = latestQuotaToken(typeAgents, preferredModel) ?? quotaMeters[0]?.token
    // 无项目且无额度时不分屏；用户开启对应 CLI 任务后再出现
    if (workspaces.length === 0 && quotaMeters.length === 0) return []

    return [
      {
        agentType,
        name: agentDisplayName(agentType),
        updatedAt: Math.max(
          0,
          ...workspaces.map((workspace) => workspace.updatedAt),
          ...typeAgents.map((agent) => agent.lastEventAt),
        ),
        quotaToken,
        quotaMeters,
        workspaces,
      },
    ]
  })
}

/**
 * Collect quota bars for a pane.
 *
 * Codex may expose multiple weekly buckets (default weekly vs Spark). Display
 * rules:
 * - Active models drive which families appear (Spark + weekly only if both models run).
 * - Idle / latest model only: one family — never keep Spark bars after switching away.
 * - Never "rebrand" Spark as a second generic 每周额度 (that caused twin weekly bars).
 */
export function collectQuotaMeters(
  agents: AgentRuntimeState[],
  agentType: AgentType,
): QuotaMeterSource[] {
  const candidatesById = new Map<string, QuotaCandidate[]>()
  const candidates = agents
    .filter((agent) => agent.agentType === agentType)
    .flatMap((agent) => quotaCandidatesForAgent(agent))

  for (const candidate of candidates) {
    const id = quotaMeterId(candidate.token)
    const group = candidatesById.get(id)
    if (group) group.push(candidate)
    else candidatesById.set(id, [candidate])
  }

  let meters: QuotaMeterSource[] = []
  for (const [id, groupedCandidates] of candidatesById) {
    const candidate = pickAuthoritativeQuotaCandidate(groupedCandidates, agentType)
    if (!candidate) continue
    meters.push({
      id,
      token: candidate.token,
      updatedAt: candidate.updatedAt,
    })
  }

  if (meters.length === 0) return []

  const models = relevantQuotaModels(agents.filter((agent) => agent.agentType === agentType))
  if (models.length > 0) {
    meters = filterMetersByModelFamily(meters, models)
  }

  // One bar per family is enough (multiple non-Spark bucket ids all labeled 每周额度).
  meters = collapseMetersPerFamily(meters, agentType)

  return meters.sort(compareQuotaMeters)
}

export function latestQuotaToken(
  agents: AgentRuntimeState[],
  preferredModel?: string,
): TokenPayload | undefined {
  const candidates = agents.flatMap(quotaCandidatesForAgent)
  if (candidates.length === 0) return undefined

  const compatiblePool = preferredModel
    ? candidates.filter((candidate) => quotaMatchesPreferredModel(candidate.token, preferredModel))
    : candidates
  const selectionBase = compatiblePool.length > 0 ? compatiblePool : candidates

  const modelPool = preferredModel
    ? selectionBase.filter((candidate) => sameModel(candidate.agent.model, preferredModel))
    : []
  const modelBase = modelPool.length > 0 ? modelPool : selectionBase
  const freshestAt = Math.max(...modelBase.map((candidate) => candidate.updatedAt))
  const recent = modelBase.filter(
    (candidate) => freshestAt - candidate.updatedAt <= QUOTA_RECENCY_WINDOW_MS,
  )
  const pool = recent.length > 0 ? recent : modelBase

  return pickLatestQuotaCandidateAcrossTypes(pool)?.token
}

export function buildWorkspaceAgentGroups(agents: AgentRuntimeState[]): WorkspaceAgentGroup[] {
  const grouped = new Map<string, AgentRuntimeState[]>()

  for (const agent of visibleTaskAgents(agents)) {
    const key = workspaceKey(agent.workspacePath)
    grouped.set(key, [...(grouped.get(key) ?? []), agent])
  }

  if (grouped.size === 0) grouped.set('', [])

  return [...grouped.entries()]
    .map(([key, groupAgents]) => {
      const workspacePath = groupAgents.find((agent) => agent.workspacePath)?.workspacePath
      const byType = new Map<AgentType, AgentRuntimeState>()
      for (const agent of groupAgents) {
        const current = byType.get(agent.agentType)
        if (!current || compareWorkspaceDisplayAgents(agent, current) < 0) {
          byType.set(agent.agentType, agent)
        }
      }
      const primary = DISPLAY_AGENT_ORDER.map(
        (agentType) => byType.get(agentType) ?? idleAgent(agentType, workspacePath),
      )
      const extras = groupAgents.filter((agent) => !DISPLAY_AGENT_ORDER.includes(agent.agentType))
      const ordered = [...primary, ...extras]
      const updatedAt = Math.max(0, ...groupAgents.map((agent) => agent.lastEventAt))

      return {
        id: key || 'workspace:unknown',
        name: workspacePath ? workspaceName(workspacePath) : '',
        workspacePath,
        updatedAt,
        token: latestToken(groupAgents),
        agents: ordered,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
}

function buildAgentWorkspaceItems(
  agentType: AgentType,
  agents: AgentRuntimeState[],
): AgentWorkspaceItem[] {
  const grouped = new Map<string, AgentRuntimeState[]>()

  for (const agent of agents) {
    // Quota-only / pathless shells must not become "未识别项目" cards.
    // They still feed collectQuotaMeters via the full agent list.
    if (!agent.workspacePath?.trim()) continue
    const key = workspaceKey(agent.workspacePath)
    if (!key) continue
    grouped.set(key, [...(grouped.get(key) ?? []), agent])
  }

  const items = [...grouped.entries()].map(([key, groupAgents]) => {
    const latest = [...groupAgents].sort(compareWorkspaceDisplayAgents)[0] ?? idleAgent(agentType)
    const workspacePath =
      latest.workspacePath ?? groupAgents.find((agent) => agent.workspacePath)?.workspacePath

    return {
      id: `${agentType}:${key}`,
      name: workspacePath ? workspaceName(workspacePath) : '',
      workspacePath,
      updatedAt: latest.lastEventAt,
      agent: workspacePath && !latest.workspacePath ? { ...latest, workspacePath } : latest,
    }
  })

  // Collapse nested project cards without applying activity-based visual ordering.
  // The renderer's persisted project-order layer assigns each card a fixed position.
  return coalesceNestedWorkspaceItems(items)
}

/**
 * Orders same-workspace sessions for one representative dashboard card.
 *
 * A disk scan's arrival time is not a model-config timestamp. Prefer an active
 * turn, then the native configuration time, so an older Sol session cannot replace
 * a newer Terra configuration merely because it wrote a token snapshot later.
 *
 * @param a First candidate runtime state.
 * @param b Second candidate runtime state.
 * @returns Sort ordering with the preferred card first.
 */
function compareWorkspaceDisplayAgents(a: AgentRuntimeState, b: AgentRuntimeState): number {
  const activeOrder = Number(isActiveState(b.state)) - Number(isActiveState(a.state))
  if (activeOrder !== 0) return activeOrder

  const modelOrder = (b.modelObservedAt ?? 0) - (a.modelObservedAt ?? 0)
  if (modelOrder !== 0) return modelOrder

  return (
    b.lastEventAt - a.lastEventAt ||
    (a.externalSessionId ?? '').localeCompare(b.externalSessionId ?? '')
  )
}

/**
 * When one workspace path is a subdirectory of another, keep a single card for
 * the parent path and surface the freshest activity state on it.
 *
 * Never treat home / Desktop / Users 等通用目录 as a "project root" that absorbs
 * real projects underneath (that turned MetalMax into a card named "Administrator").
 */
export function coalesceNestedWorkspaceItems(items: AgentWorkspaceItem[]): AgentWorkspaceItem[] {
  if (items.length <= 1) return items

  const byPathLength = [...items].sort((a, b) => {
    const ap = normalizeWorkspacePath(a.workspacePath)?.length ?? 0
    const bp = normalizeWorkspacePath(b.workspacePath)?.length ?? 0
    return ap - bp
  })

  const kept: AgentWorkspaceItem[] = []
  for (const item of byPathLength) {
    const path = normalizeWorkspacePath(item.workspacePath) ?? ''
    const parentIndex = kept.findIndex((candidate) => {
      const parentPath = normalizeWorkspacePath(candidate.workspacePath) ?? ''
      if (!path || !parentPath) return false
      if (path !== parentPath && !path.startsWith(`${parentPath}/`)) return false
      // Generic roots (profile, Desktop, …) must not swallow real project cards.
      if (isGenericWorkspaceRoot(candidate.workspacePath)) return false
      return true
    })

    if (parentIndex < 0) {
      kept.push(item)
      continue
    }

    const parent = kept[parentIndex]!
    if (item.updatedAt < parent.updatedAt) continue

    kept[parentIndex] = {
      ...parent,
      updatedAt: item.updatedAt,
      agent: {
        ...item.agent,
        // Keep the root path for the card title/badge.
        workspacePath: parent.workspacePath ?? item.agent.workspacePath,
      },
    }
  }

  return kept
}

/**
 * Paths that are containers for many unrelated projects, not a single project root.
 * Matching is case-insensitive via {@link normalizeWorkspacePath}.
 */
export function isGenericWorkspaceRoot(path: string | undefined): boolean {
  const normalized = normalizeWorkspacePath(path)
  if (!normalized) return true

  const parts = normalized.split('/').filter(Boolean)
  if (parts.length <= 1) return true

  const last = parts[parts.length - 1] ?? ''
  const genericLeaf = new Set([
    'users',
    'home',
    'desktop',
    'documents',
    'downloads',
    'pictures',
    'music',
    'videos',
    'onedrive',
    'appdata',
    'temp',
    'tmp',
    'public',
    'library',
    'workspaces',
    'projects',
    'repos',
    'code',
    'dev',
    'src',
  ])
  if (genericLeaf.has(last)) return true

  // C:/Users/<name> or /Users/<name> — user profile root.
  const usersIdx = parts.findIndex((part) => part === 'users' || part === 'home')
  if (usersIdx >= 0 && parts.length === usersIdx + 2) return true

  return false
}

function visibleTaskAgents(agents: AgentRuntimeState[]): AgentRuntimeState[] {
  return agents.filter((agent) => !agent.taskHidden)
}

function idleAgent(agentType: AgentType, workspacePath?: string): AgentRuntimeState {
  return {
    agentType,
    state: TurnState.IDLE,
    toolCallCount: 0,
    needPermission: false,
    needUserInput: false,
    activity: undefined,
    lastEventAt: 0,
    unread: false,
    workspacePath,
  }
}

function latestToken(agents: AgentRuntimeState[]): TokenPayload | undefined {
  return agents.filter((agent) => agent.token).sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
    ?.token
}

function hasVisibleRateLimits(token: TokenPayload | undefined, agentType: AgentType): boolean {
  const windows = visibleRateLimitWindows(token, agentType)
  return Boolean(windows.fiveHour ?? windows.sevenDay)
}

function quotaCandidatesForAgent(agent: AgentRuntimeState): QuotaCandidate[] {
  const token = agent.token
  if (!token) return []

  const bucketCandidates = Object.entries(token.quotaBuckets ?? {})
    .map(([, bucket]) => quotaCandidateFromBucket(agent, token, bucket))
    .filter((candidate): candidate is QuotaCandidate => Boolean(candidate))

  const model = agent.model
  if (bucketCandidates.length > 0) {
    if (!model) return bucketCandidates

    // gpt-5.6-sol → non-Spark buckets only (never show idle Spark 0% as a second weekly bar).
    const family = bucketCandidates.filter((candidate) =>
      meterMatchesModelFamily(candidate.token, model),
    )
    if (family.length > 0) return family

    // Only Spark buckets stored while model is non-Spark: hide them (do not rebrand).
    return []
  }

  if (!hasVisibleRateLimits(token, agent.agentType)) return []

  // Single payload: hide Spark-tagged limits when the session model is not Spark.
  if (model && !meterMatchesModelFamily(token, model)) {
    return []
  }
  return [{ agent, token, updatedAt: agent.lastEventAt }]
}

function quotaCandidateFromBucket(
  agent: AgentRuntimeState,
  baseToken: TokenPayload,
  bucket: TokenQuotaBucket,
): QuotaCandidate | undefined {
  // Copy usage/context fields but do NOT inherit top-level Spark limit identity
  // onto a different bucket (undefined bucket name used to leave sticky Spark labels).
  const {
    rateLimitId: _ignoreId,
    rateLimitName: _ignoreName,
    rateLimits: _ignoreLimits,
    quotaBuckets: _ignoreBuckets,
    ...rest
  } = baseToken
  const token: TokenPayload = {
    ...rest,
    rateLimits: bucket.rateLimits,
    ...(bucket.rateLimitId ? { rateLimitId: bucket.rateLimitId } : {}),
    ...(bucket.rateLimitName ? { rateLimitName: bucket.rateLimitName } : {}),
  }

  if (!hasVisibleRateLimits(token, agent.agentType)) return undefined
  return { agent, token, updatedAt: bucket.updatedAt ?? agent.lastEventAt }
}

/** Maximum reset-time jitter accepted as one account quota period. */
const QUOTA_RESET_TOLERANCE_MS = 60_000

interface LatestQuotaPeriod<T> {
  values: T[]
  resetAt?: number
}

/**
 * Keeps only candidates from the latest reset period.
 *
 * The comparison is anchored to the group's maximum reset timestamp. Unlike a
 * rounded time bucket, this cannot split two near-identical resets at an
 * arbitrary boundary or create a non-transitive pairwise comparison.
 *
 * @param values Candidate values to cluster.
 * @param getResetAt Extracts a normalized reset timestamp from a value.
 * @returns Latest-period values and their maximum reset timestamp.
 */
function selectLatestQuotaPeriod<T>(
  values: T[],
  getResetAt: (value: T) => number | undefined,
): LatestQuotaPeriod<T> {
  const withReset = values.flatMap((value) => {
    const resetAt = getResetAt(value)
    return resetAt === undefined ? [] : [{ value, resetAt }]
  })
  if (withReset.length === 0) return { values }

  const latestResetAt = Math.max(...withReset.map((entry) => entry.resetAt))
  return {
    values: withReset
      .filter((entry) => latestResetAt - entry.resetAt <= QUOTA_RESET_TOLERANCE_MS)
      .map((entry) => entry.value),
    resetAt: latestResetAt,
  }
}

/**
 * Selects the authoritative account quota candidate for one meter ID.
 *
 * @param candidates Same-ID quota candidates from concurrent sessions.
 * @param agentType CLI family used to select visible windows.
 * @returns Best candidate from the latest reset period.
 */
function pickAuthoritativeQuotaCandidate(
  candidates: QuotaCandidate[],
  agentType: AgentType,
): QuotaCandidate | undefined {
  const period = selectLatestQuotaPeriod(candidates, (candidate) =>
    primaryQuotaResetAt(candidate.token, agentType),
  )
  const expired = period.resetAt !== undefined && period.resetAt <= Date.now()
  return [...period.values].sort((a, b) => {
    const pressure = comparePrimaryQuotaPressure(a.token, b.token, agentType, expired)
    if (pressure !== 0) return pressure

    const aActive = isActiveState(a.agent.state) ? 1 : 0
    const bActive = isActiveState(b.agent.state) ? 1 : 0
    return (
      bActive - aActive ||
      b.agent.lastEventAt - a.agent.lastEventAt ||
      b.updatedAt - a.updatedAt ||
      quotaPressure(b.token, agentType) - quotaPressure(a.token, agentType)
    )
  })[0]
}

/**
 * Selects the newest authoritative candidate when callers provide mixed CLI types.
 *
 * @param candidates Quota candidates remaining after model and recency filters.
 * @returns Best per-type candidate, with the freshest source winning across types.
 */
function pickLatestQuotaCandidateAcrossTypes(
  candidates: QuotaCandidate[],
): QuotaCandidate | undefined {
  const byType = new Map<AgentType, QuotaCandidate[]>()
  for (const candidate of candidates) {
    const type = candidate.agent.agentType
    const group = byType.get(type)
    if (group) group.push(candidate)
    else byType.set(type, [candidate])
  }
  return [...byType.entries()]
    .flatMap(([type, entries]) => pickAuthoritativeQuotaCandidate(entries, type) ?? [])
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
}

/**
 * Orders two same-period quota values by their primary visible usage.
 *
 * @param a First quota token.
 * @param b Second quota token.
 * @param agentType CLI family used to select visible windows.
 * @param expired Whether the selected period has reached its reset boundary.
 * @returns Negative when `a` is the more authoritative value.
 */
function comparePrimaryQuotaPressure(
  a: TokenPayload,
  b: TokenPayload,
  agentType: AgentType,
  expired: boolean,
): number {
  const ap = primaryQuotaUsedPercent(a, agentType)
  const bp = primaryQuotaUsedPercent(b, agentType)
  if (ap < 0) return bp < 0 ? 0 : 1
  if (bp < 0) return -1
  if (ap === bp) return 0
  return expired ? ap - bp : bp - ap
}

function quotaPressure(token: TokenPayload | undefined, agentType: AgentType): number {
  const windows = visibleRateLimitWindows(token, agentType)
  return Math.max(
    normalizedPercent(windows.fiveHour?.usedPercent),
    normalizedPercent(windows.sevenDay?.usedPercent),
  )
}

function preferredQuotaModel(agents: AgentRuntimeState[]): string | undefined {
  return relevantQuotaModels(agents)[0]
}

/**
 * Models that should drive quota UI right now:
 * 1. All models on **active** turns (user may run Spark + weekly models together).
 * 2. Otherwise only the single **most recent** model — historical sessions must not
 *    keep stale Spark (or weekly) bars visible after the user switched models.
 */
function relevantQuotaModels(agents: AgentRuntimeState[]): string[] {
  const active = agents
    .filter((agent) => isActiveState(agent.state) && Boolean(agent.model) && agent.lastEventAt > 0)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)
    .map((agent) => agent.model!)

  if (active.length > 0) return [...new Set(active)]

  const latest = [...agents]
    .filter((agent) => Boolean(agent.model) && agent.lastEventAt > 0)
    .sort((a, b) => b.lastEventAt - a.lastEventAt)[0]
  return latest?.model ? [latest.model] : []
}

/** Drop Spark bars for non-Spark models (and the reverse). */
function filterMetersByModelFamily(
  meters: QuotaMeterSource[],
  models: string[],
): QuotaMeterSource[] {
  const wantSpark = models.some((model) => isSparkModel(normalizeModel(model)))
  const wantNonSpark = models.some((model) => !isSparkModel(normalizeModel(model)))
  return meters.filter((meter) => {
    const spark = tokenLooksLikeSpark(meter.token)
    if (spark && wantSpark) return true
    if (!spark && wantNonSpark) return true
    return false
  })
}

/**
 * Collapse multiple non-Spark (or multiple Spark) rows into one each.
 * Otherwise codex + default + stripped rows all render as duplicate 每周额度.
 */
function collapseMetersPerFamily(
  meters: QuotaMeterSource[],
  agentType: AgentType,
): QuotaMeterSource[] {
  const spark: QuotaMeterSource[] = []
  const weekly: QuotaMeterSource[] = []
  for (const meter of meters) {
    if (tokenLooksLikeSpark(meter.token)) spark.push(meter)
    else weekly.push(meter)
  }
  const pickBest = (group: QuotaMeterSource[]): QuotaMeterSource | undefined => {
    if (group.length === 0) return undefined
    const period = selectLatestQuotaPeriod(group, (meter) =>
      primaryQuotaResetAt(meter.token, agentType),
    )
    const expired = period.resetAt !== undefined && period.resetAt <= Date.now()
    return [...period.values].sort((a, b) => {
      const pressure = comparePrimaryQuotaPressure(a.token, b.token, agentType, expired)
      return (
        pressure ||
        b.updatedAt - a.updatedAt ||
        quotaPressure(b.token, agentType) - quotaPressure(a.token, agentType)
      )
    })[0]
  }
  return [pickBest(weekly), pickBest(spark)].filter((meter): meter is QuotaMeterSource =>
    Boolean(meter),
  )
}

/**
 * Returns the reset timestamp for the primary visible quota window.
 *
 * The weekly window is authoritative whenever present. This prevents Codex's
 * hidden five-hour metadata from changing which weekly value is displayed.
 *
 * @param token Token payload containing zero or more quota windows.
 * @param agentType CLI family used to filter hidden quota windows.
 * @returns Normalized reset timestamp, when valid.
 */
function primaryQuotaResetAt(token: TokenPayload, agentType: AgentType): number | undefined {
  const windows = visibleRateLimitWindows(token, agentType)
  const resetAt = windows.sevenDay?.resetsAt ?? windows.fiveHour?.resetsAt
  return normalizeResetAt(resetAt)
}

/**
 * Returns the primary visible quota percentage for monotonic selection.
 *
 * @param token Token payload containing zero or more quota windows.
 * @param agentType CLI family used to filter hidden quota windows.
 * @returns Normalized percentage, or `-1` when unavailable.
 */
function primaryQuotaUsedPercent(token: TokenPayload, agentType: AgentType): number {
  const windows = visibleRateLimitWindows(token, agentType)
  return normalizedPercent(windows.sevenDay?.usedPercent ?? windows.fiveHour?.usedPercent)
}

/**
 * Normalizes a Unix-seconds or epoch-milliseconds reset boundary.
 *
 * @param value Candidate reset timestamp.
 * @returns Epoch milliseconds, or `undefined` for invalid input.
 */
function normalizeResetAt(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1_000_000_000_000 ? value * 1000 : value
}

function isActiveState(state: TurnState): boolean {
  return (
    state === TurnState.PROMPT_SUBMITTED ||
    state === TurnState.THINKING ||
    state === TurnState.TOOL_RUNNING ||
    state === TurnState.WAITING_PERMISSION ||
    state === TurnState.WAITING_USER_INPUT
  )
}

function sameModel(a: string | undefined, b: string): boolean {
  return normalizeModel(a) === normalizeModel(b)
}

function quotaMatchesPreferredModel(
  token: TokenPayload | undefined,
  preferredModel: string,
): boolean {
  return meterMatchesModelFamily(token ?? { accuracy: 'unknown' }, preferredModel)
}

function meterMatchesModelFamily(token: TokenPayload, model: string): boolean {
  return tokenLooksLikeSpark(token) === isSparkModel(normalizeModel(model))
}

function tokenLooksLikeSpark(token: TokenPayload | undefined): boolean {
  if (!token) return false
  return isSparkQuota(normalizeModel(`${token.rateLimitId ?? ''} ${token.rateLimitName ?? ''}`))
}

function isSparkQuota(value: string): boolean {
  return value.includes('spark') || value.includes('bengalfox')
}

/** Only true Spark models share the Spark weekly bucket — not every gpt-5.3 build. */
function isSparkModel(value: string): boolean {
  return value.includes('spark') || value.includes('bengalfox')
}

function quotaMeterId(token: TokenPayload): string {
  return token.rateLimitId?.trim() || token.rateLimitName?.trim() || 'default'
}

function compareQuotaMeters(a: QuotaMeterSource, b: QuotaMeterSource): number {
  const aSpark = isSparkQuota(
    normalizeModel(`${a.token.rateLimitId ?? ''} ${a.token.rateLimitName ?? ''}`),
  )
  const bSpark = isSparkQuota(
    normalizeModel(`${b.token.rateLimitId ?? ''} ${b.token.rateLimitName ?? ''}`),
  )
  // Default weekly first, Spark (and other named buckets) below — matches Codex status line order.
  if (aSpark !== bSpark) return aSpark ? 1 : -1
  return b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
}

function normalizeModel(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? ''
}

function normalizedPercent(value: number | undefined): number {
  return value != null && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : -1
}

function workspaceName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  )
}

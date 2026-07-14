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

export const DISPLAY_AGENT_ORDER: readonly AgentType[] = ['claude_code', 'codex', 'grok']
const QUOTA_RECENCY_WINDOW_MS = 30 * 60_000

/** 人类可读的 agent 显示名称。 */
export function agentDisplayName(agentType: AgentType): string {
  if (agentType === 'codex') return 'Codex'
  if (agentType === 'grok') return 'Grok'
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
 * - Prefer buckets that match **currently active** models (concurrent use → both bars).
 * - If nothing is active, use only the **most recently used** model — do not keep
 *   showing Spark just because an older session once used it.
 */
export function collectQuotaMeters(
  agents: AgentRuntimeState[],
  agentType: AgentType,
): QuotaMeterSource[] {
  const byId = new Map<string, QuotaMeterSource>()

  for (const agent of agents) {
    if (agent.agentType !== agentType) continue
    for (const candidate of quotaCandidatesForAgent(agent)) {
      const id = quotaMeterId(candidate.token)
      const previous = byId.get(id)
      if (!previous || candidate.updatedAt >= previous.updatedAt) {
        byId.set(id, {
          id,
          token: candidate.token,
          updatedAt: candidate.updatedAt,
        })
      }
    }
  }

  let meters = [...byId.values()]
  if (meters.length === 0) return []

  const models = relevantQuotaModels(agents.filter((agent) => agent.agentType === agentType))
  if (models.length > 0) {
    const matched = meters.filter((meter) =>
      models.some((model) => quotaMatchesPreferredModel(meter.token, model)),
    )
    if (matched.length > 0) {
      meters = matched
    } else {
      // Never fall back to the wrong family (e.g. Spark while on gpt-5.6-sol).
      meters = filterMetersByModelFamily(meters, models)
    }
  }

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

  return [...pool].sort(compareQuotaCandidates)[0]?.token
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
      const byType = new Map(groupAgents.map((agent) => [agent.agentType, agent]))
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
    const key = workspaceKey(agent.workspacePath)
    grouped.set(key, [...(grouped.get(key) ?? []), agent])
  }

  const items = [...grouped.entries()].map(([key, groupAgents]) => {
    const latest =
      [...groupAgents].sort((a, b) => b.lastEventAt - a.lastEventAt)[0] ?? idleAgent(agentType)
    const workspacePath =
      latest.workspacePath ?? groupAgents.find((agent) => agent.workspacePath)?.workspacePath

    return {
      id: `${agentType}:${key || 'unknown'}`,
      name: workspacePath ? workspaceName(workspacePath) : '',
      workspacePath,
      updatedAt: latest.lastEventAt,
      agent: workspacePath && !latest.workspacePath ? { ...latest, workspacePath } : latest,
    }
  })

  // Collapse nested project cards (subdir cwd noise) into the parent root card.
  return coalesceNestedWorkspaceItems(items).sort(
    (a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
  )
}

/**
 * When one workspace path is a subdirectory of another, keep a single card for
 * the parent path and surface the freshest activity state on it.
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
      return path === parentPath || path.startsWith(`${parentPath}/`)
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
    if (model) {
      const matched = bucketCandidates.filter((candidate) =>
        quotaMatchesPreferredModel(candidate.token, model),
      )
      if (matched.length > 0) return matched

      // gpt-5.6 / non-Spark must not surface Spark buckets from an earlier turn.
      const family = bucketCandidates.filter((candidate) =>
        meterMatchesModelFamily(candidate.token, model),
      )
      if (family.length > 0) return family

      // Only Spark data left while model is non-Spark: show weekly numbers without Spark branding.
      if (!isSparkModel(normalizeModel(model)) && hasVisibleRateLimits(token, agent.agentType)) {
        return [
          {
            agent,
            token: stripSparkBranding(token),
            updatedAt: agent.lastEventAt,
          },
        ]
      }
      return []
    }
    return bucketCandidates
  }

  if (!hasVisibleRateLimits(token, agent.agentType)) return []

  // Single payload without buckets: drop Spark branding when the session model is not Spark.
  const displayToken =
    model && !isSparkModel(normalizeModel(model)) && tokenLooksLikeSpark(token)
      ? stripSparkBranding(token)
      : token
  if (model && !quotaMatchesPreferredModel(displayToken, model) && tokenLooksLikeSpark(token)) {
    // Still Spark-only metadata with a non-Spark model — show neutral weekly bar.
    return isSparkModel(normalizeModel(model))
      ? [{ agent, token: displayToken, updatedAt: agent.lastEventAt }]
      : [{ agent, token: stripSparkBranding(token), updatedAt: agent.lastEventAt }]
  }
  return [{ agent, token: displayToken, updatedAt: agent.lastEventAt }]
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

function compareQuotaCandidates(a: QuotaCandidate, b: QuotaCandidate): number {
  return (
    b.updatedAt - a.updatedAt ||
    quotaPressure(b.token, b.agent.agentType) - quotaPressure(a.token, a.agent.agentType)
  )
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

/** Drop Spark bars for non-Spark models (and the reverse) when id matching fails. */
function filterMetersByModelFamily(
  meters: QuotaMeterSource[],
  models: string[],
): QuotaMeterSource[] {
  const wantSpark = models.some((model) => isSparkModel(normalizeModel(model)))
  const wantNonSpark = models.some((model) => !isSparkModel(normalizeModel(model)))
  return meters.filter((meter) => {
    const spark = isSparkQuota(
      normalizeModel(`${meter.token.rateLimitId ?? ''} ${meter.token.rateLimitName ?? ''}`),
    )
    if (spark && wantSpark) return true
    if (!spark && wantNonSpark) return true
    return false
  })
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
  const preferred = normalizeModel(preferredModel)
  const preferredSpark = isSparkModel(preferred)
  const bucketSpark = tokenLooksLikeSpark(token)

  // Hard rule: Spark buckets only for Spark models (and vice versa for default weekly).
  if (bucketSpark !== preferredSpark) return false

  const bucket = normalizeModel(`${token?.rateLimitId ?? ''} ${token?.rateLimitName ?? ''}`)
  if (!bucket) return true

  // Do not require GPT version equality between model id and quota bucket name —
  // gpt-5.6-sol uses the shared non-Spark weekly bucket (often unlabeled or "Codex").
  return true
}

function meterMatchesModelFamily(token: TokenPayload, model: string): boolean {
  return tokenLooksLikeSpark(token) === isSparkModel(normalizeModel(model))
}

function tokenLooksLikeSpark(token: TokenPayload | undefined): boolean {
  if (!token) return false
  return isSparkQuota(normalizeModel(`${token.rateLimitId ?? ''} ${token.rateLimitName ?? ''}`))
}

/** Keep usage numbers but remove Spark limit labels for non-Spark sessions. */
function stripSparkBranding(token: TokenPayload): TokenPayload {
  const next: TokenPayload = { ...token }
  delete next.rateLimitId
  delete next.rateLimitName
  // Drop Spark-only buckets so they are not re-expanded later.
  if (next.quotaBuckets) {
    const kept: NonNullable<TokenPayload['quotaBuckets']> = {}
    for (const [key, bucket] of Object.entries(next.quotaBuckets)) {
      const label = normalizeModel(`${bucket.rateLimitId ?? ''} ${bucket.rateLimitName ?? key}`)
      if (isSparkQuota(label)) continue
      kept[key] = bucket
    }
    next.quotaBuckets = Object.keys(kept).length > 0 ? kept : undefined
  }
  return next
}

function isDefaultCodexQuota(value: string): boolean {
  // Default Codex weekly bucket id/name is plain "codex", not Spark variants.
  const tokens = value.split(/[\s/_-]+/).filter(Boolean)
  return tokens.includes('codex') && !isSparkQuota(value)
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

function extractGptVersion(value: string): string | undefined {
  return value.match(/gpt[-_\s]*(\d+(?:\.\d+)?)/)?.[1]
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

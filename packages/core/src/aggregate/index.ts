/**
 * 聚合辅助函数：把各 agent 的运行时状态收敛为 UI 与硬件消费的视图 ——
 * 托盘总体指示、完整状态快照，以及极简设备投影。
 *
 * @module core/aggregate
 */
import {
  type AgentRuntimeState,
  type AgentType,
  type DeviceAgentState,
  type DeviceAgentStatusV1,
  type DeviceMainState,
  type DeviceQuotaBucketV1,
  type DeviceQuotaWindowV1,
  type DeviceStatus,
  type DeviceStatusV1,
  type DeviceTokenUsageV1,
  DEVICE_PROTOCOL_VERSION,
  type OverallState,
  type StatusSnapshot,
  type TokenPayload,
  type TokenQuotaBucket,
  type TokenRateLimitWindow,
  TurnState,
} from '@codepulse/shared'

const DEVICE_AGENT_ORDER: readonly AgentType[] = ['codex', 'claude_code', 'grok']
const MAX_DEVICE_QUOTA_BUCKETS = 8
const MAX_DEVICE_MESSAGE_LENGTH = 96

/**
 * 把所有 agent 状态收敛为托盘图标的单一总体指示。
 *
 * 采用需求 §5.6 的颜色优先级
 * （error > attention > running > done-unread > idle），
 * 并对超时轮次额外提供「stuck」信号。
 *
 * @param agents 所有已知的 agent 运行时状态。
 * @returns 托盘应显示的唯一 {@link OverallState}。
 */
export function deriveOverall(agents: AgentRuntimeState[]): OverallState {
  const visibleAgents = agents.filter((agent) => !agent.taskHidden)
  if (visibleAgents.length === 0) return 'idle'
  const states = visibleAgents.map((a) => a.state)
  if (states.includes(TurnState.ERROR)) return 'error'
  if (states.includes(TurnState.USAGE_LIMITED)) return 'limited'
  if (states.includes(TurnState.TIMEOUT)) return 'stuck'
  if (
    states.includes(TurnState.WAITING_PERMISSION) ||
    states.includes(TurnState.WAITING_USER_INPUT)
  )
    return 'attention'
  if (
    states.includes(TurnState.PROMPT_SUBMITTED) ||
    states.includes(TurnState.THINKING) ||
    states.includes(TurnState.TOOL_RUNNING)
  )
    return 'running'
  if (visibleAgents.some((a) => a.state === TurnState.DONE && a.unread)) return 'done_unread'
  return 'idle'
}

/**
 * 把各 agent 状态包装为 {@link StatusSnapshot}：计算推导出的总体指示
 * 并盖上时间戳。
 *
 * @param agents 所有已知的 agent 运行时状态。
 * @param now 当前时间（epoch 毫秒，可注入便于测试）。
 * @returns `GET /api/status` 返回并经 WebSocket 推送的快照。
 */
export function buildStatusSnapshot(agents: AgentRuntimeState[], now = Date.now()): StatusSnapshot {
  return { overall: deriveOverall(agents), agents, updatedAt: now }
}

/**
 * 把完整状态快照投影为 `GET /api/device/status` 提供的极简硬件视图
 * （需求 §5.9）。
 *
 * 选取最值得关注的 agent（先 attention，再 running）作为 `activeAgent`，
 * 并暴露 Claude 的上下文百分比与 Codex 的状态。
 *
 * @param snapshot 待投影的完整状态快照。
 * @returns 适合 ESP32 客户端的扁平 {@link DeviceStatus}。
 */
export function toDeviceStatus(snapshot: StatusSnapshot): DeviceStatus {
  const visibleAgents = snapshot.agents.filter((agent) => !agent.taskHidden)
  const attention = visibleAgents.find(
    (a) => a.state === TurnState.WAITING_PERMISSION || a.state === TurnState.WAITING_USER_INPUT,
  )
  const running = visibleAgents.find(
    (a) =>
      a.state === TurnState.TOOL_RUNNING ||
      a.state === TurnState.THINKING ||
      a.state === TurnState.PROMPT_SUBMITTED,
  )
  const active = attention ?? running ?? visibleAgents[0] ?? null
  const claude =
    visibleAgents.find((a) => a.agentType === 'claude_code') ??
    snapshot.agents.find((a) => a.agentType === 'claude_code')
  const codex = visibleAgents.find((a) => a.agentType === 'codex')

  return {
    mainState: mapMainState(snapshot.overall),
    activeAgent: active?.agentType ?? null,
    message: active?.activity ?? overallMessage(snapshot.overall),
    claudeContext: claude?.token?.contextUsedPercent ?? null,
    codexState: codex ? codex.state : null,
    updatedAt: snapshot.updatedAt,
  }
}

/**
 * 把桌面端完整内存状态投影为版本化的局域网设备协议。
 *
 * 每种 CLI 最多返回一条最相关状态，同时合并该 CLI 在不同工作区捕获到的
 * 额度桶。绝对工作区路径不会离开电脑，只传目录名。
 */
export function toDeviceStatusV1(snapshot: StatusSnapshot): DeviceStatusV1 {
  const projections = DEVICE_AGENT_ORDER.flatMap((agentType) => {
    const states = snapshot.agents.filter((agent) => agent.agentType === agentType)
    if (states.length === 0) return []

    const source = selectDeviceAgent(states)
    const hidden = Boolean(source.taskHidden)
    const value: DeviceAgentStatusV1 = {
      type: agentType,
      state: hidden ? 'idle' : mapDeviceAgentState(source.state),
      project: hidden ? null : compactText(workspaceBasename(source.workspacePath), 64),
      model: compactText(source.model, 64),
      activity: hidden ? null : projectDeviceActivity(source),
      needsAttention:
        !hidden &&
        (source.needPermission ||
          source.needUserInput ||
          source.state === TurnState.WAITING_PERMISSION ||
          source.state === TurnState.WAITING_USER_INPUT),
      tokens: projectDeviceTokens(source.token),
      quotas: projectDeviceQuotas(states, agentType),
      updatedAt: finiteTimestamp(source.lastEventAt),
    }
    return [{ source, value }]
  })

  const active = projections
    .filter((projection) => !projection.source.taskHidden)
    .sort((a, b) => compareDeviceAgents(a.source, b.source))[0]
  const mainState = mapMainState(snapshot.overall)
  const content: Omit<DeviceStatusV1, 'revision'> = {
    protocolVersion: DEVICE_PROTOCOL_VERSION,
    mainState,
    activeAgent: active?.source.agentType ?? null,
    message:
      (active ? projectDeviceActivity(active.source) : null) ?? overallMessage(snapshot.overall),
    agents: projections.map((projection) => projection.value),
    updatedAt: snapshot.agents.reduce(
      (latest, agent) => Math.max(latest, finiteTimestamp(agent.lastEventAt)),
      0,
    ),
  }

  return { ...content, revision: createDeviceRevision(content) }
}

/**
 * 把总体指示映射为设备 API 暴露的紧凑 `mainState` 字符串。
 *
 * @param overall 聚合后的总体状态。
 * @returns 小写、设备友好的状态字符串。
 */
function mapMainState(overall: OverallState): DeviceMainState {
  switch (overall) {
    case 'attention':
      return 'waiting_permission'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    case 'limited':
      return 'usage_limited'
    case 'done_unread':
      return 'done'
    case 'stuck':
      return 'stuck'
    case 'idle':
    default:
      return 'idle'
  }
}

function mapDeviceAgentState(state: AgentRuntimeState['state']): DeviceAgentState {
  switch (state) {
    case TurnState.PROMPT_SUBMITTED:
      return 'prompt_submitted'
    case TurnState.THINKING:
      return 'thinking'
    case TurnState.TOOL_RUNNING:
      return 'tool_running'
    case TurnState.WAITING_PERMISSION:
      return 'waiting_permission'
    case TurnState.WAITING_USER_INPUT:
      return 'waiting_user_input'
    case TurnState.DONE:
      return 'done'
    case TurnState.ERROR:
      return 'error'
    case TurnState.TIMEOUT:
      return 'timeout'
    case TurnState.USAGE_LIMITED:
      return 'usage_limited'
    case TurnState.CANCELLED:
      return 'cancelled'
    case TurnState.IDLE:
    default:
      return 'idle'
  }
}

function selectDeviceAgent(agents: AgentRuntimeState[]): AgentRuntimeState {
  return [...agents].sort(compareDeviceAgents)[0] as AgentRuntimeState
}

function compareDeviceAgents(a: AgentRuntimeState, b: AgentRuntimeState): number {
  return (
    deviceAgentPriority(a) - deviceAgentPriority(b) ||
    finiteTimestamp(b.lastEventAt) - finiteTimestamp(a.lastEventAt) ||
    (a.workspacePath ?? '').localeCompare(b.workspacePath ?? '')
  )
}

function deviceAgentPriority(agent: AgentRuntimeState): number {
  if (agent.taskHidden) return 100
  switch (agent.state) {
    case TurnState.ERROR:
      return 0
    case TurnState.USAGE_LIMITED:
      return 1
    case TurnState.TIMEOUT:
      return 2
    case TurnState.WAITING_PERMISSION:
    case TurnState.WAITING_USER_INPUT:
      return 3
    case TurnState.TOOL_RUNNING:
    case TurnState.THINKING:
    case TurnState.PROMPT_SUBMITTED:
      return 4
    case TurnState.DONE:
      return agent.unread ? 5 : 6
    case TurnState.CANCELLED:
      return 7
    case TurnState.IDLE:
    default:
      return 8
  }
}

function projectDeviceTokens(token: TokenPayload | undefined): DeviceTokenUsageV1 {
  return {
    input: finiteCount(token?.input),
    cachedInput: finiteCount(token?.cachedInput),
    output: finiteCount(token?.output),
    reasoningOutput: finiteCount(token?.reasoningOutput),
    total: finiteCount(token?.total),
    contextUsedPercent: finitePercent(token?.contextUsedPercent),
    contextWindow: finiteCount(token?.contextWindow),
    contextStale: Boolean(token?.contextStale),
    contextCompressed: Boolean(token?.contextCompressed),
    accuracy: token?.accuracy ?? 'unknown',
  }
}

interface DeviceQuotaCandidate extends DeviceQuotaBucketV1 {
  updatedAt: number
}

function projectDeviceQuotas(
  agents: AgentRuntimeState[],
  agentType: AgentType,
): DeviceQuotaBucketV1[] {
  const candidates: DeviceQuotaCandidate[] = []

  for (const agent of agents) {
    const token = agent.token
    if (!token) continue

    const current = quotaCandidate(
      token.rateLimitId ?? `${agentType}:default`,
      token.rateLimitName,
      token.rateLimits,
      agent.lastEventAt,
    )
    if (current) candidates.push(current)

    for (const [key, bucket] of Object.entries(token.quotaBuckets ?? {})) {
      const candidate = quotaBucketCandidate(key, bucket, agent.lastEventAt)
      if (candidate) candidates.push(candidate)
    }
  }

  candidates.sort(
    (a, b) =>
      a.updatedAt - b.updatedAt ||
      a.id.localeCompare(b.id) ||
      a.name?.localeCompare(b.name ?? '') ||
      0,
  )
  const merged = new Map<string, DeviceQuotaCandidate>()
  for (const candidate of candidates) {
    const key = candidate.id.toLowerCase()
    const previous = merged.get(key)
    merged.set(key, {
      id: candidate.id,
      name: candidate.name ?? previous?.name ?? null,
      fiveHour: candidate.fiveHour ?? previous?.fiveHour ?? null,
      weekly: candidate.weekly ?? previous?.weekly ?? null,
      updatedAt: Math.max(previous?.updatedAt ?? 0, candidate.updatedAt),
    })
  }

  return [...merged.values()]
    .filter((bucket) => bucket.fiveHour !== null || bucket.weekly !== null)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, MAX_DEVICE_QUOTA_BUCKETS)
    .map(({ id, name, fiveHour, weekly }) => ({ id, name, fiveHour, weekly }))
}

function quotaBucketCandidate(
  key: string,
  bucket: TokenQuotaBucket,
  agentUpdatedAt: number,
): DeviceQuotaCandidate | undefined {
  return quotaCandidate(
    bucket.rateLimitId ?? key,
    bucket.rateLimitName,
    bucket.rateLimits,
    bucket.updatedAt ?? agentUpdatedAt,
  )
}

function quotaCandidate(
  rawId: string,
  rawName: string | undefined,
  limits: TokenPayload['rateLimits'],
  updatedAt: number,
): DeviceQuotaCandidate | undefined {
  const fiveHour = projectQuotaWindow(limits?.fiveHour)
  const weekly = projectQuotaWindow(limits?.sevenDay)
  if (!fiveHour && !weekly) return undefined

  return {
    id: compactText(rawId, 64) ?? 'default',
    name: compactText(rawName, 64),
    fiveHour,
    weekly,
    updatedAt: finiteTimestamp(updatedAt),
  }
}

function projectQuotaWindow(window: TokenRateLimitWindow | undefined): DeviceQuotaWindowV1 | null {
  if (!window) return null
  const projected: DeviceQuotaWindowV1 = {
    usedPercent: finitePercent(window.usedPercent),
    resetsAt: resetAtEpochSeconds(window.resetsAt),
    windowMinutes: finiteCount(window.windowMinutes),
  }
  if (
    projected.usedPercent === null &&
    projected.resetsAt === null &&
    projected.windowMinutes === null
  ) {
    return null
  }
  return projected
}

function workspaceBasename(path: string | undefined): string | null {
  const cleaned = path?.trim().replace(/[\\/]+$/g, '')
  if (!cleaned) return null
  return cleaned.split(/[\\/]+/).at(-1) ?? null
}

function projectDeviceActivity(agent: AgentRuntimeState): string | null {
  const workspacePath = agent.workspacePath?.trim().replace(/[\\/]+$/g, '')
  let activity = agent.activity
  if (activity && workspacePath) {
    const replacement = workspaceBasename(workspacePath) ?? 'project'
    const variants = new Set([
      workspacePath,
      workspacePath.replace(/\\/g, '/'),
      workspacePath.replace(/\//g, '\\'),
    ])
    for (const variant of variants) {
      activity = activity.split(variant).join(replacement)
    }
  }
  return compactText(activity, MAX_DEVICE_MESSAGE_LENGTH)
}

function compactText(value: string | null | undefined, maxLength: number): string | null {
  const normalized = value?.trim().replace(/\s+/g, ' ')
  if (!normalized) return null
  const characters = Array.from(normalized)
  if (characters.length <= maxLength) return normalized
  return `${characters.slice(0, Math.max(1, maxLength - 1)).join('')}…`
}

function finiteCount(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.trunc(value)
}

function finitePercent(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)) * 100) / 100
}

function finiteTimestamp(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0
  return Math.trunc(value)
}

function resetAtEpochSeconds(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.trunc(value >= 1_000_000_000_000 ? value / 1000 : value)
}

/**
 * FNV-1a 足够用作小型展示载荷的变化指纹。时间戳不参与计算，
 * 因此仅有心跳/事件时间变化时不会迫使水墨屏刷新。
 */
function createDeviceRevision(content: Omit<DeviceStatusV1, 'revision'>): string {
  const serialized = JSON.stringify(content, (key, value: unknown) =>
    key === 'updatedAt' ? undefined : value,
  )
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return `v${DEVICE_PROTOCOL_VERSION}-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 当没有 agent 活动描述可用时，为设备提供默认中文消息。
 *
 * @param overall 聚合后的总体状态。
 * @returns 简短的人类可读状态消息。
 */
function overallMessage(overall: OverallState): string {
  switch (overall) {
    case 'attention':
      return '需要用户介入'
    case 'running':
      return 'AI 正在执行'
    case 'error':
      return '执行出错'
    case 'limited':
      return '已达用量上限'
    case 'done_unread':
      return '一轮任务已完成'
    case 'stuck':
      return '疑似卡住'
    default:
      return '空闲'
  }
}

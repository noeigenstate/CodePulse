import { createHash } from 'node:crypto'
import { hudProviderRank, isDisplayAgent, workspaceKey,
  type AgentRuntimeState, type DisplayAgentType } from '@codepulse/shared'

export const DEVICE_ORDER_LIMIT = 2048
export interface DeviceThreadOrder {
  version: 2
  groups: string[]
  threads: string[]
  /** Session -> first-observed project; contains hashes only, never paths. */
  threadGroups: Record<string, string>
}
export type DeviceThreadSource = AgentRuntimeState & { agentType: DisplayAgentType }

export function isDeviceThreadSource(source: AgentRuntimeState): source is DeviceThreadSource {
  return isDisplayAgent(source.agentType) && !source.taskHidden && Boolean(source.lastEventAt) &&
    Boolean(source.workspacePath || source.externalSessionId)
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24)
}
/** Preserve protocol IDs: task names and workspace migration never rename a session. */
export function deviceThreadId(source: AgentRuntimeState): string {
  return hash(source.externalSessionId ? ['session', source.agentType, source.externalSessionId]
    : ['workspace', source.agentType, source.workspacePath])
}
/** App metadata can use a file URI while CLI events use a filesystem path.
 * Normalize only device presentation grouping; never mutate canonical data. */
function deviceGroupPath(value: string | undefined): string {
  if (value && /^file:/i.test(value)) {
    try {
      const url = new URL(value)
      let path = decodeURIComponent(url.pathname)
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
      return workspaceKey(path)
    } catch { /* Preserve malformed input as a distinct path. */ }
  }
  return workspaceKey(value)
}
function groupId(source: AgentRuntimeState): string {
  const path = deviceGroupPath(source.workspacePath)
  return path ? hash(['group', path]) : deviceThreadId(source)
}
export function normalizeDeviceThreadOrder(value: unknown): DeviceThreadOrder {
  const v = value && typeof value === 'object' ? value as Partial<DeviceThreadOrder> : {}
  const keys = (a: unknown): string[] => Array.isArray(a)
    ? [...new Set(a.filter((x): x is string => typeof x === 'string' && /^[a-f0-9]{24}$/.test(x)))]
    : []
  // Version 1 kept group positions but recomputed each session's membership
  // from every transient cwd. Migrate positions, then bind current sessions once.
  const version = (value as { version?: unknown } | null)?.version
  const supported = version === 1 || version === 2
  const groups = supported ? keys(v.groups) : [], threads = supported ? keys(v.threads) : []
  const groupSet = new Set(groups), threadSet = new Set(threads)
  const threadGroups: Record<string, string> = {}
  if (version === 2 && v.threadGroups && typeof v.threadGroups === 'object') {
    for (const [id, group] of Object.entries(v.threadGroups))
      if (threadSet.has(id) && typeof group === 'string' && groupSet.has(group))
        threadGroups[id] = group
  }
  return { version: 2, groups, threads, threadGroups }
}
function retain(previous: string[], current: string[]): string[] {
  const live = new Set(current), next = [...new Set([...previous, ...current])]
  let excess = Math.max(0, next.length - DEVICE_ORDER_LIMIT)
  return next.filter(key => {
    if (excess && !live.has(key)) { excess--; return false }
    return true
  })
}
/** Persist first appearance independently of transient activity and user titles. */
export function reconcileDeviceThreadOrder(sources: readonly AgentRuntimeState[], previous?: DeviceThreadOrder): DeviceThreadOrder {
  const old = normalizeDeviceThreadOrder(previous)
  const threads = retain(old.threads, sources.map(deviceThreadId))
  const threadGroups = { ...old.threadGroups }
  for (const source of sources) {
    const id = deviceThreadId(source)
    // A hook cwd is execution context, not a request to move a project card.
    // Keep this presentation binding across state/path changes and restarts.
    threadGroups[id] ??= groupId(source)
  }
  const groups = retain(old.groups, sources.map(source => threadGroups[deviceThreadId(source)]!))
  const keptThreads = new Set(threads), keptGroups = new Set(groups)
  for (const [id, group] of Object.entries(threadGroups))
    if (!keptThreads.has(id) || !keptGroups.has(group)) delete threadGroups[id]
  return { version: 2, groups, threads, threadGroups }
}
/** Same-project cards stay adjacent; each native session remains a separate card. */
export function orderDeviceThreadSources<T extends AgentRuntimeState>(sources: readonly T[], previous?: DeviceThreadOrder): T[] {
  const order = reconcileDeviceThreadOrder(sources, previous)
  const groups = new Map(order.groups.map((key,i)=>[key,i]))
  const threads = new Map(order.threads.map((key,i)=>[key,i]))
  const boundGroup = (source: AgentRuntimeState) => order.threadGroups[deviceThreadId(source)]!
  const ranks = new Map<string,number>()
  for (const source of sources) {
    const key = boundGroup(source)
    ranks.set(key, Math.min(ranks.get(key) ?? Infinity, hudProviderRank(source.agentType)))
  }
  return [...sources].sort((a,b) => {
    const ga=boundGroup(a), gb=boundGroup(b)
    return ranks.get(ga)! - ranks.get(gb)! || groups.get(ga)! - groups.get(gb)! ||
      hudProviderRank(a.agentType) - hudProviderRank(b.agentType) ||
      threads.get(deviceThreadId(a))! - threads.get(deviceThreadId(b))!
  })
}

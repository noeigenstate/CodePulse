import type { AgentType } from './agent.js'

export const DISPLAY_AGENT_TYPES = ['codex', 'claude_code', 'grok'] as const
export type DisplayAgentType = (typeof DISPLAY_AGENT_TYPES)[number]
export interface DeviceDisplayConfig {
  version: 1
  mode: 'hud' | 'usage'
  metric: 'remaining' | 'used'
  showQuota: boolean
  showEnvironment: boolean
  inverted?: boolean
  agents: DisplayAgentType[]
  /** Explicit desktop selection; the device never rotates pages automatically. */
  page: number
}
export const DEFAULT_DEVICE_DISPLAY: Readonly<DeviceDisplayConfig> = {
  version: 1, mode: 'hud', metric: 'remaining', showQuota: true,
  showEnvironment: true, inverted: false, agents: ['codex', 'claude_code'], page: 0,
}
export interface DeviceThreadV1 {
  id: string
  type: DisplayAgentType
  title: string
  detail: string
  state: import('./device.js').DeviceAgentState
  /** Additive shared presentation metadata; old firmware may ignore it. */
  level?: import('../presentation/hudState.js').HudStateLevel
  unread?: boolean
  /** Opaque hash; never contains a workspace path or native conversation id. */
  groupId?: string
}
export interface DeviceDisplaySnapshot {
  config: DeviceDisplayConfig
  status: import('./device.js').DeviceStatusV1
  serverAvailable: boolean
}
export function normalizeDeviceDisplay(value: unknown): DeviceDisplayConfig {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    version: 1,
    mode: v.mode === 'usage' ? 'usage' : 'hud',
    metric: v.metric === 'used' ? 'used' : 'remaining',
    showQuota: typeof v.showQuota === 'boolean' ? v.showQuota : true,
    showEnvironment: typeof v.showEnvironment === 'boolean' ? v.showEnvironment : true,
    inverted: v.inverted === true,
    agents: Array.isArray(v.agents)
      ? DISPLAY_AGENT_TYPES.filter(t => (v.agents as unknown[]).includes(t))
      : [...DEFAULT_DEVICE_DISPLAY.agents],
    page: typeof v.page === 'number' && Number.isInteger(v.page) && v.page >= 0
      ? Math.min(v.page, 9999) : 0,
  }
}
export function isDisplayAgent(type: AgentType): type is DisplayAgentType {
  return (DISPLAY_AGENT_TYPES as readonly string[]).includes(type)
}
export function deviceGridColumns(count: number): 1 | 2 | 3 {
  return count > 6 ? 3 : count > 3 ? 2 : 1
}

/** Same quota selection as the MCU, including Spark and unknown windows. */
export function deviceDisplayQuota(agent?: import('./device.js').DeviceAgentStatusV1): import('./device.js').DeviceQuotaBucketV1 | undefined {
  let best = -1
  let selected: import('./device.js').DeviceQuotaBucketV1 | undefined
  for (const bucket of agent?.quotas ?? []) {
    if (bucket.weekly?.usedPercent == null && bucket.fiveHour?.usedPercent == null) continue
    const sameModel = Boolean(agent?.model?.toLowerCase().includes('spark')) === bucket.id.toLowerCase().includes('spark')
    const canonical = bucket.id === agent?.type || (agent?.type === 'claude_code' && bucket.id === 'claude')
    const priority = 1 + (sameModel ? 20 : 0) + (canonical ? 10 : 0)
    if (priority > best) { best = priority; selected = bucket }
  }
  return selected
}

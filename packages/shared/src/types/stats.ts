/**
 * 用量统计（Usage 页面）共享类型。
 *
 * 数据来自本机 CLI 日志汇总到 SQLite 的 usage ledger，不上传云端。
 *
 * @module shared/types/stats
 */
import type { AgentType } from './agent.js'

/** 统计时间范围预设。 */
export type StatsRangePreset = 'today' | '7d' | '30d'

/** 趋势图粒度。 */
export type StatsTrendGranularity = 'day' | 'week' | 'month'

/** Token and cost totals from the usage ledger (CLI logs, per request). */
export interface UsageLedgerTotals {
  /** API requests. */
  requests: number
  /** Uncached input tokens. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** input + cacheRead + cacheWrite + output. */
  tokens: number
  /** API-equivalent cost at official list prices, for priced models only. */
  costUsd: number
  /** Tokens from models without a known official price. */
  unpricedTokens: number
  /** Prompts the user typed. */
  rounds: number
}

/** One conversation, used as the unit of "a problem" in the rounds view. */
export interface UsageLedgerSession {
  agentType: AgentType
  sessionId: string
  projectPath: string
  projectName: string
  /** Preview of the first prompt in range. */
  title?: string
  startedAt: number
  lastActiveAt: number
  rounds: number
  /** Rounds answered by each model, most first. */
  models: { model: string; rounds: number }[]
  tokens: number
  costUsd: number
  unpricedTokens: number
}

export interface UsageLedgerSnapshot {
  rangePreset: StatsRangePreset
  rangeStart: number
  rangeEnd: number
  generatedAt: number
  /** Date the price table was verified. */
  pricingAsOf: string
  totals: UsageLedgerTotals & { sessions: number; projects: number }
  /** Same-length period immediately before the range, for deltas. */
  previous: UsageLedgerTotals
  byAgent: (UsageLedgerTotals & { agentType: AgentType; sessions: number })[]
  byModel: (UsageLedgerTotals & { model: string; agentType: AgentType; priced: boolean })[]
  byProject: (UsageLedgerTotals & {
    path: string
    name: string
    agents: AgentType[]
    sessions: number
    lastActiveAt: number
  })[]
  /** Trend bucket size: hourly for `today`, otherwise the requested granularity. */
  trendBucket: 'hour' | StatsTrendGranularity
  trend: {
    bucketStart: number
    costUsd: number
    tokens: number
    byAgent: Partial<Record<AgentType, number>>
  }[]
  /** Conversations with the most rounds in range. */
  sessions: UsageLedgerSession[]
  /** Rounds per model across conversations. */
  modelRounds: { model: string; rounds: number; sessions: number; avgRounds: number }[]
  /** Last completed log scan, when known. */
  scannedAt?: number
}

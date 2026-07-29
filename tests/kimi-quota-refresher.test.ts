import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { KimiQuotaRefresher } from '@codepulse/local-server'
import type { AgentEvent } from '@codepulse/shared'

function kimiHookEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    id: `hook-${Math.random()}`,
    source: 'kimi',
    eventType: 'tool_start',
    externalSessionId: 'session-1',
    workspacePath: 'F:/project',
    timestamp: Date.now(),
    ...overrides,
  }
}

const QUOTA = {
  rateLimits: {
    fiveHour: { usedPercent: 11, resetsAt: 1_900_000_000, windowMinutes: 300 },
    sevenDay: { usedPercent: 10, resetsAt: 1_900_600_000, windowMinutes: 10_080 },
  },
  updatedAt: Date.now(),
  source: 'api' as const,
}

test('ignores non-kimi events', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let calls = 0
  const refresher = new KimiQuotaRefresher({
    hub,
    resolveQuota: async () => {
      calls += 1
      return QUOTA
    },
  })
  refresher.observe(kimiHookEvent({ source: 'claude_code' }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 0)
  refresher.stop()
})

test('publishes account quota onto the triggering kimi session', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  hub.ingest(kimiHookEvent())
  const refresher = new KimiQuotaRefresher({
    hub,
    resolveQuota: async () => QUOTA,
  })

  refresher.observe(kimiHookEvent({ eventType: 'tool_end' }))
  await new Promise((resolve) => setTimeout(resolve, 10))

  const agent = hub
    .snapshot()
    .agents.find((item) => item.agentType === 'kimi' && item.externalSessionId === 'session-1')
  assert.equal(agent?.token?.rateLimits?.fiveHour?.usedPercent, 11)
  assert.equal(agent?.token?.rateLimits?.sevenDay?.usedPercent, 10)
  assert.equal(agent?.token?.rateLimitId, 'kimi-code')
  refresher.stop()
})

test('throttles bursts and runs one trailing refresh per interval', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let calls = 0
  const refresher = new KimiQuotaRefresher({
    hub,
    minIntervalMs: 40,
    resolveQuota: async () => {
      calls += 1
      return QUOTA
    },
  })

  refresher.observe(kimiHookEvent())
  refresher.observe(kimiHookEvent())
  refresher.observe(kimiHookEvent())
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 1)

  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(calls, 2)
  refresher.stop()
})

test('never re-arms on its own quota-refresh output', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let calls = 0
  const refresher = new KimiQuotaRefresher({
    hub,
    minIntervalMs: 0,
    resolveQuota: async () => {
      calls += 1
      return QUOTA
    },
  })

  refresher.observe(kimiHookEvent({ internal: { quotaRefresh: true } }))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(calls, 0)
  refresher.stop()
})

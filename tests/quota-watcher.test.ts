import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { QuotaRefreshWatcher, readCodexQuotaTokenFromFile } from '@codepulse/local-server'

test('readCodexQuotaTokenFromFile reads Codex rate limits from the bound rollout file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-'))
  const file = join(dir, 'rollout.jsonl')
  try {
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'task_started', model_context_window: 258_400 },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              last_token_usage: { input_tokens: 51_680, total_tokens: 52_000 },
              total_token_usage: { input_tokens: 100_000, total_tokens: 101_000 },
            },
            rate_limits: {
              limit_id: 'codex_bengalfox',
              limit_name: 'GPT-5.3-Codex-Spark',
              primary: {
                used_percent: 0,
                resets_at: Math.floor(Date.now() / 1000) + 3_600,
                window_minutes: 300,
              },
              secondary: {
                used_percent: 4,
                resets_at: Math.floor(Date.now() / 1000) + 86_400,
                window_minutes: 10_080,
              },
            },
          },
        }),
      ].join('\n'),
    )

    const token = await readCodexQuotaTokenFromFile(file)

    assert.equal(token?.contextWindow, 258_400)
    assert.equal(token?.contextUsedPercent, 20)
    assert.equal(token?.rateLimitId, 'codex_bengalfox')
    assert.equal(token?.rateLimitName, 'GPT-5.3-Codex-Spark')
    assert.equal(token?.rateLimits?.fiveHour?.usedPercent, 0)
    assert.ok((token?.rateLimits?.fiveHour?.resetsAt ?? 0) > Date.now() / 1000)
    assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 4)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('QuotaRefreshWatcher refreshes only the bound Codex quota source', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const refreshed = new Promise<void>((resolve) => {
    hub.on('status', () => {
      const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      if (codex?.token?.rateLimits?.fiveHour?.usedPercent === 0) resolve()
    })
  })
  const watcher = new QuotaRefreshWatcher({
    hub,
    now: () => 1_000_000,
    scheduleOffsetsMs: [0],
    disableSteadyPoll: true,
    readToken: async () => ({
      contextUsedPercent: 2,
      rateLimits: {
        fiveHour: { usedPercent: 0, resetsAt: 2_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 1, resetsAt: 9_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    }),
  })

  try {
    hub.on('event', (event) => watcher.observe(event))
    hub.ingest({
      id: 'quota',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      model: 'gpt-5.5',
      tokenSourcePath: 'E:/codex/session-a.jsonl',
      timestamp: 900_000,
      token: {
        contextUsedPercent: 90,
        rateLimits: {
          fiveHour: { usedPercent: 99, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 8, resetsAt: 9_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    })

    await refreshed

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.workspacePath, 'E:/project/a')
    assert.equal(codex?.lastEventAt, 900_000)
    assert.equal(codex?.model, 'gpt-5.5')
    assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 0)
    assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 2_000)
  } finally {
    watcher.stop()
  }
})

test('QuotaRefreshWatcher allows weekly refresh when only the five-hour reset is stale', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const refreshed = new Promise<void>((resolve) => {
    hub.on('status', () => {
      const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      if (codex?.token?.rateLimits?.sevenDay?.resetsAt === 10_000) resolve()
    })
  })
  const watcher = new QuotaRefreshWatcher({
    hub,
    now: () => 9_000_000,
    scheduleOffsetsMs: [0],
    disableSteadyPoll: true,
    readToken: async () => ({
      contextUsedPercent: 2,
      rateLimits: {
        fiveHour: { usedPercent: 99, resetsAt: 1_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 0, resetsAt: 10_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    }),
  })

  try {
    hub.on('event', (event) => watcher.observe(event))
    hub.ingest({
      id: 'quota',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      tokenSourcePath: 'E:/codex/session-a.jsonl',
      timestamp: 8_000_000,
      token: {
        contextUsedPercent: 90,
        rateLimits: {
          fiveHour: { usedPercent: 99, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 8, resetsAt: 9_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    })

    await refreshed

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.lastEventAt, 8_000_000)
    assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 1_000)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 0)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, 10_000)
  } finally {
    watcher.stop()
  }
})

test('QuotaRefreshWatcher skips stale reset reads from unchanged rollout data', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let quotaRefreshEvents = 0
  const watcher = new QuotaRefreshWatcher({
    hub,
    now: () => 1_000_000,
    scheduleOffsetsMs: [0],
    disableSteadyPoll: true,
    readToken: async () => ({
      contextUsedPercent: 90,
      rateLimits: {
        fiveHour: { usedPercent: 99, resetsAt: 1_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 8, resetsAt: 9_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    }),
  })

  try {
    hub.on('event', (event) => {
      watcher.observe(event)
      if (event.id.startsWith('quota-refresh:')) quotaRefreshEvents += 1
    })
    hub.ingest({
      id: 'quota',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      tokenSourcePath: 'E:/codex/session-a.jsonl',
      timestamp: 1_000_000,
      token: {
        contextUsedPercent: 90,
        rateLimits: {
          fiveHour: { usedPercent: 99, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 8, resetsAt: 9_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 0))

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(quotaRefreshEvents, 0)
    assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 99)
    assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 1_000)
  } finally {
    watcher.stop()
  }
})

test('readCodexQuotaTokenFromFile soft-resets expired limits to 0% instead of stripping', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-soft-'))
  const file = join(dir, 'rollout.jsonl')
  const past = Math.floor(Date.now() / 1000) - 3_600
  try {
    await writeFile(
      file,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256_000,
            last_token_usage: { input_tokens: 10_000, total_tokens: 10_100 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 87,
              resets_at: past,
              window_minutes: 10_080,
            },
          },
        },
      }) + '\n',
    )

    const token = await readCodexQuotaTokenFromFile(file)
    assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 0)
    assert.equal(token?.rateLimits?.sevenDay?.resetsAt, past)
    assert.ok(token?.rateLimits, 'must keep rateLimits so UI is not "等待命令行同步额度"')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

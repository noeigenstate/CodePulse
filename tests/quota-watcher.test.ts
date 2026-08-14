import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import {
  QuotaRefreshWatcher,
  readCodexQuotaObservationFromFile,
  readCodexQuotaTokenFromFile,
  readCodexRolloutSnapshotFromFile,
} from '@codepulse/local-server'

test('Codex quota observation identity changes only for a new native quota row', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-identity-'))
  const file = join(dir, 'rollout.jsonl')
  const quotaRow = JSON.stringify({
    timestamp: '2026-08-12T12:00:00.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 10, total_tokens: 10 } },
      rate_limits: {
        limit_id: 'codex',
        primary: { used_percent: 12, resets_at: 2_000_000_000, window_minutes: 10_080 },
      },
    },
  })
  try {
    await writeFile(file, `${quotaRow}\n`, 'utf8')
    const first = await readCodexQuotaObservationFromFile(file)
    await appendFile(file, `${JSON.stringify({ type: 'response_item', payload: 'noise' })}\n`)
    const replay = await readCodexQuotaObservationFromFile(file)
    await appendFile(file, `${quotaRow}\n`)
    const next = await readCodexQuotaObservationFromFile(file)

    assert.ok(first.observationIdentity)
    assert.equal(replay.observationIdentity, first.observationIdentity)
    assert.notEqual(next.observationIdentity, first.observationIdentity)
    assert.equal(first.token?.contextWindow, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

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
              model_context_window: 258_400,
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

    assert.equal(token?.contextWindow, undefined)
    assert.equal(token?.contextUsedPercent, undefined)
    assert.equal(token?.rateLimitId, 'codex_bengalfox')
    assert.equal(token?.rateLimitName, 'GPT-5.3-Codex-Spark')
    assert.equal(token?.rateLimits?.fiveHour?.usedPercent, 0)
    assert.ok((token?.rateLimits?.fiveHour?.resetsAt ?? 0) > Date.now() / 1000)
    assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 4)
    assert.equal(token?.accuracy, 'exact')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCodexRolloutSnapshotFromFile resolves an exact model effective window', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-quota-model-window-'))
  const sessions = join(home, 'sessions', '2026', '08', '12')
  const file = join(sessions, 'rollout.jsonl')
  try {
    await mkdir(sessions, { recursive: true })
    await writeFile(
      join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-5.6-terra',
            context_window: 272_000,
            effective_context_window_percent: 95,
            max_context_window: 1_000_000,
          },
        ],
      }),
    )
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'turn_context',
          payload: { model: 'gpt-5.6-terra', reasoning_effort: 'ultra' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 25_840, total_tokens: 25_840 } },
          },
        }),
      ].join('\n'),
    )

    const snapshot = await readCodexRolloutSnapshotFromFile(file, { codexHome: home })

    assert.equal(snapshot.token?.contextWindow, 258_400)
    assert.equal(snapshot.token?.contextUsedPercent, 10)
    assert.notEqual(snapshot.token?.contextWindow, 1_000_000)
    assert.equal(snapshot.token?.accuracy, 'exact')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('readCodexRolloutSnapshotFromFile scans beyond 4 MiB and rejoins split rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-deep-rollout-'))
  const file = join(dir, 'rollout.jsonl')
  const startedAt = Date.now() - 2_000
  const resetAt = Math.floor(Date.now() / 1_000) + 86_400
  try {
    const modelRow = JSON.stringify({
      timestamp: new Date(startedAt - 100).toISOString(),
      type: 'turn_context',
      payload: {
        model: 'gpt-5.6-sol',
        reasoning_effort: 'ultra',
        // Larger than one reverse-read block: parsing this row proves that the
        // scanner rejoins JSON and UTF-8 content split across block boundaries.
        padding: `前${'x'.repeat(1_100_000)}后`,
      },
    })
    const buriedNoise = JSON.stringify({
      type: 'response_item',
      payload: { text: 'n'.repeat(5 * 1024 * 1024) },
    })
    assert.ok(Buffer.byteLength(buriedNoise) > 4 * 1024 * 1024)

    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'deep-rollout' } }),
        modelRow,
        JSON.stringify({
          timestamp: new Date(startedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'deep-turn',
            started_at: startedAt / 1_000,
            model_context_window: 258_400,
          },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258_400,
              last_token_usage: { input_tokens: 25_840, total_tokens: 25_840 },
            },
            rate_limits: {
              limit_id: 'codex',
              primary: {
                used_percent: 37,
                resets_at: resetAt,
                window_minutes: 10_080,
              },
            },
          },
        }),
        buriedNoise,
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258_400,
              last_token_usage: { input_tokens: 51_680, total_tokens: 51_680 },
            },
          },
        }),
      ].join('\n') + '\n',
    )

    const snapshot = await readCodexRolloutSnapshotFromFile(file)

    assert.equal(snapshot.model, 'gpt-5.6-sol')
    assert.equal(snapshot.reasoningEffort, 'ultra')
    assert.equal(snapshot.token?.contextUsedPercent, 20)
    assert.equal(snapshot.token?.rateLimits?.sevenDay?.usedPercent, 37)
    assert.deepEqual(snapshot.turnTiming, {
      state: 'active',
      externalTurnId: 'deep-turn',
      startedAt,
      observedAt: startedAt,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCodexRolloutSnapshotFromFile preserves explicit zero context input', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-zero-window-'))
  const file = join(dir, 'rollout.jsonl')
  try {
    await writeFile(
      file,
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258_400,
            last_token_usage: {
              input_tokens: 0,
              cached_input_tokens: 20_000,
              total_tokens: 0,
            },
          },
        },
      }) + '\n',
    )

    const token = (await readCodexRolloutSnapshotFromFile(file)).token

    assert.equal(token?.contextWindow, 258_400)
    assert.equal(token?.contextUsedPercent, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex rollout timing retains an aborted turn as a cancelled outcome', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-codex-aborted-'))
  const file = join(dir, 'rollout.jsonl')
  const startedAt = Date.now() - 5_000
  const abortedAt = startedAt + 2_000
  try {
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: new Date(startedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'aborted-turn',
            started_at: startedAt / 1_000,
          },
        }),
        JSON.stringify({
          timestamp: new Date(abortedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'turn_aborted',
            turn_id: 'aborted-turn',
            completed_at: abortedAt / 1_000,
            duration_ms: abortedAt - startedAt,
          },
        }),
      ].join('\n'),
      'utf8',
    )

    const snapshot = await readCodexRolloutSnapshotFromFile(file)
    assert.deepEqual(snapshot.turnTiming, {
      state: 'completed',
      externalTurnId: 'aborted-turn',
      outcome: 'cancelled',
      startedAt,
      elapsedMs: abortedAt - startedAt,
      observedAt: abortedAt,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex rollout timing keeps an unmatched parent active after a nested task ends', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-codex-nested-timing-'))
  const file = join(dir, 'rollout.jsonl')
  const parentStartedAt = Date.now() - 5_000
  const nestedStartedAt = parentStartedAt + 1_000
  const nestedCompletedAt = nestedStartedAt + 1_000
  try {
    await writeFile(
      file,
      [
        JSON.stringify({
          timestamp: new Date(parentStartedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'parent-turn',
            started_at: parentStartedAt / 1_000,
          },
        }),
        JSON.stringify({
          timestamp: new Date(parentStartedAt + 500).toISOString(),
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
        }),
        JSON.stringify({
          timestamp: new Date(nestedStartedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'nested-turn',
            started_at: nestedStartedAt / 1_000,
          },
        }),
        JSON.stringify({
          timestamp: new Date(nestedCompletedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'nested-turn',
            completed_at: nestedCompletedAt / 1_000,
            duration_ms: nestedCompletedAt - nestedStartedAt,
          },
        }),
      ].join('\n'),
      'utf8',
    )

    const snapshot = await readCodexRolloutSnapshotFromFile(file)
    assert.deepEqual(snapshot.turnTiming, {
      state: 'active',
      externalTurnId: 'parent-turn',
      startedAt: parentStartedAt,
      observedAt: parentStartedAt,
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Codex terminal refresh stops after the Hub-confirmed root start', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-codex-terminal-fast-path-'))
  const file = join(dir, 'rollout.jsonl')
  const startedAt = Date.now() - 2_000
  const completedAt = startedAt + 1_000
  let scannedBytes = 0
  try {
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'fast-terminal-session' } }),
        JSON.stringify({ type: 'response_item', payload: 'x'.repeat(6 * 1024 * 1024) }),
        JSON.stringify({
          timestamp: new Date(startedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'confirmed-root-turn',
            started_at: startedAt / 1_000,
            model_context_window: 258_400,
          },
        }),
        JSON.stringify({
          timestamp: new Date(startedAt + 10).toISOString(),
          type: 'turn_context',
          payload: { model: 'gpt-5.6-sol', reasoning_effort: 'ultra' },
        }),
        JSON.stringify({
          timestamp: new Date(completedAt - 10).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 258_400,
              last_token_usage: { input_tokens: 25_840, total_tokens: 25_840 },
            },
          },
        }),
        JSON.stringify({
          timestamp: new Date(completedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            turn_id: 'confirmed-root-turn',
            completed_at: completedAt / 1_000,
            duration_ms: completedAt - startedAt,
          },
        }),
      ].join('\n'),
      'utf8',
    )

    const snapshot = await readCodexRolloutSnapshotFromFile(file, {
      includeQuota: false,
      expectedTerminalTurnId: 'confirmed-root-turn',
      onScanBytes: (totalBytes) => {
        scannedBytes = totalBytes
      },
    })

    assert.deepEqual(snapshot.turnTiming, {
      state: 'completed',
      externalTurnId: 'confirmed-root-turn',
      startedAt,
      elapsedMs: completedAt - startedAt,
      observedAt: completedAt,
    })
    assert.ok(scannedBytes <= 2 * 1024 * 1024, 'terminal refresh must not scan to session_meta')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('QuotaRefreshWatcher publishes one bound lower observation without clearing quota', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const refreshed = new Promise<void>((resolve) => {
    hub.on('event', (event) => {
      if (event.id.startsWith('quota-refresh:')) resolve()
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
    assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 99)
    assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 1_000)
  } finally {
    watcher.stop()
  }
})

test('QuotaRefreshWatcher holds the first lower weekly observation independently', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const refreshed = new Promise<void>((resolve) => {
    hub.on('event', (event) => {
      if (event.id.startsWith('quota-refresh:')) resolve()
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
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 8)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, 9_000)
  } finally {
    watcher.stop()
  }
})

test('QuotaRefreshWatcher confirms a lower fallback quota after five physical reads', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const now = Date.now()
  const initialReset = (now + 100) / 1_000
  const refreshedReset = (now + 120_000) / 1_000
  const lowerReadings = [10, 11, 12, 13, 14]
  let readCalls = 0
  let refreshEvents = 0
  const watcher = new QuotaRefreshWatcher({
    hub,
    scheduleOffsetsMs: [0, 5, 10, 15, 20],
    disableSteadyPoll: true,
    readToken: async () => ({
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: {
          usedPercent: lowerReadings[Math.min(readCalls++, lowerReadings.length - 1)],
          resetsAt: refreshedReset,
          windowMinutes: 10_080,
        },
      },
      accuracy: 'exact',
    }),
  })

  try {
    hub.on('event', (event) => {
      watcher.observe(event)
      if (event.id.startsWith('quota-refresh:')) refreshEvents += 1
    })
    hub.ingest({
      id: 'quota-before-reset',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'fallback-five-read',
      cwd: 'E:/project/fallback-five-read',
      tokenSourcePath: 'E:/codex/fallback-five-read.jsonl',
      timestamp: now,
      token: {
        rateLimitId: 'codex',
        rateLimits: {
          sevenDay: { usedPercent: 80, resetsAt: initialReset, windowMinutes: 10_080 },
        },
        accuracy: 'exact',
      },
    })

    const deadline = Date.now() + 1_000
    while (refreshEvents < 5 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(readCalls, 5)
    assert.equal(refreshEvents, 5)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 14)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, refreshedReset)
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

test('QuotaRefreshWatcher coalesces same-path reads and contains rollout I/O failures', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let readCalls = 0
  let quotaRefreshEvents = 0
  const watcher = new QuotaRefreshWatcher({
    hub,
    now: () => 1_000_000,
    scheduleOffsetsMs: [0],
    disableSteadyPoll: true,
    readToken: async () => {
      readCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error('rollout disappeared')
    },
  })

  try {
    hub.on('event', (event) => {
      watcher.observe(event)
      if (event.id.startsWith('quota-refresh:')) quotaRefreshEvents += 1
    })
    hub.ingest({
      id: 'quota-read-error',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-read-error',
      cwd: 'E:/project/read-error',
      tokenSourcePath: 'E:/codex/read-error.jsonl',
      timestamp: 1_000_000,
      token: {
        rateLimits: {
          fiveHour: { usedPercent: 10, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 20, resetsAt: 1_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    })

    await new Promise((resolve) => setTimeout(resolve, 20))

    assert.equal(readCalls, 1)
    assert.equal(quotaRefreshEvents, 0)
  } finally {
    watcher.stop()
  }
})

test('QuotaRefreshWatcher drops an in-flight rollout read after App Server takes authority', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  let authoritative = false
  let finishRead!: (token: Awaited<ReturnType<typeof readCodexQuotaTokenFromFile>>) => void
  let signalReadStarted!: () => void
  const readStarted = new Promise<void>((resolve) => {
    signalReadStarted = resolve
  })
  const watcher = new QuotaRefreshWatcher({
    hub,
    now: () => 1_000_000,
    scheduleOffsetsMs: [0],
    disableSteadyPoll: true,
    isCodexQuotaAuthoritative: () => authoritative,
    readToken: async () => {
      signalReadStarted()
      return await new Promise((finish) => {
        finishRead = finish
      })
    },
  })
  let quotaRefreshEvents = 0

  try {
    hub.on('event', (event) => {
      watcher.observe(event)
      if (event.id.startsWith('quota-refresh:')) quotaRefreshEvents += 1
    })
    hub.ingest({
      id: 'rollout-before-app-server',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'authority-race',
      cwd: 'E:/project/authority-race',
      tokenSourcePath: 'E:/codex/authority-race.jsonl',
      timestamp: 1_000_000,
      token: {
        rateLimitId: 'codex',
        rateLimits: {
          sevenDay: { usedPercent: 90, resetsAt: 1_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    })

    await readStarted
    authoritative = true
    finishRead({
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 99, resetsAt: 2_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    })
    await new Promise((resolve) => setTimeout(resolve, 10))

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(quotaRefreshEvents, 0)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 90)
  } finally {
    watcher.stop()
  }
})

test('readCodexQuotaTokenFromFile retains expired official limits without fabricating 0%', async () => {
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
    assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 87)
    assert.equal(token?.rateLimits?.sevenDay?.resetsAt, past)
    assert.ok(token?.rateLimits, 'must keep the last official rate-limit snapshot')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readCodexRolloutSnapshotFromFile backfills expired limits onto newer context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codepulse-quota-expired-backfill-'))
  const file = join(dir, 'rollout.jsonl')
  const past = Math.floor(Date.now() / 1000) - 3_600
  try {
    await writeFile(
      file,
      [
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
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 256_000,
              last_token_usage: { input_tokens: 20_000, total_tokens: 20_100 },
            },
          },
        }),
      ].join('\n') + '\n',
    )

    const token = (await readCodexRolloutSnapshotFromFile(file)).token
    assert.equal(token?.contextUsedPercent, 7.8125)
    assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 87)
    assert.equal(token?.rateLimits?.sevenDay?.resetsAt, past)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

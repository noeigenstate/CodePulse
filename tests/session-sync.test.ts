import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { SessionSyncService } from '@codepulse/local-server'

test('SessionSyncService hydrates Codex project from local rollout within one scan', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-')
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const sessionId = '019f7000-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/background-task'
  const rollout = join(sessions, `rollout-2026-07-14T12-00-00-${sessionId}.jsonl`)
  const futureReset = Math.floor(Date.now() / 1000) + 86_400

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T12:00:00.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol', effort: 'max' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'noise', value: 'x'.repeat(600_000) },
      }),
      JSON.stringify({
        timestamp: '2026-07-14T12:01:00.000Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.6-terra', effort: 'ultra' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 51200, output_tokens: 100, total_tokens: 51300 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 37,
              window_minutes: 10080,
              resets_at: futureReset,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  const now = new Date()
  await utimes(rollout, now, now)

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.syncNow()
    const codex = hub.snapshot().agents.find((a) => a.agentType === 'codex')
    assert.ok(codex, 'expected codex agent after disk sync')
    assert.equal(codex?.workspacePath?.replace(/\\/g, '/'), cwd.replace(/\\/g, '/'))
    assert.ok(
      (codex?.token?.contextUsedPercent ?? 0) > 15,
      `expected context % from last_token_usage, got ${codex?.token?.contextUsedPercent}`,
    )
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 37)
    assert.equal(codex?.model, 'gpt-5.6-terra')
    assert.equal(codex?.reasoningEffort, 'ultra')
    assert.equal(codex?.modelObservedAt, Date.parse('2026-07-14T12:01:00.000Z'))
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService prefers the newest model config over a newer same-workspace mtime', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-model-priority-')
  const sessions = join(home, 'sessions', '2026', '07', '16')
  const cwd = 'E:/work/same-workspace'
  const solId = '019f7004-aaaa-bbbb-cccc-ddddeeeeffff'
  const terraId = '019f7005-aaaa-bbbb-cccc-ddddeeeeffff'
  const solRollout = join(sessions, `rollout-2026-07-16T12-00-00-${solId}.jsonl`)
  const terraRollout = join(sessions, `rollout-2026-07-16T12-01-00-${terraId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  const writeRollout = async (
    file: string,
    sessionId: string,
    model: string,
    effort: string,
    timestamp: string,
  ): Promise<void> => {
    await writeFile(
      file,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
        JSON.stringify({ timestamp, type: 'turn_context', payload: { model, effort } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } },
          },
        }),
      ].join('\n'),
      'utf8',
    )
  }

  await writeRollout(solRollout, solId, 'gpt-5.6-sol', 'max', '2026-07-16T12:00:00.000Z')
  await writeRollout(terraRollout, terraId, 'gpt-5.6-terra', 'ultra', '2026-07-16T12:01:00.000Z')
  const now = Date.now()
  // Simulate an older Sol session writing a later token snapshot after Terra changed model.
  await utimes(terraRollout, new Date(now - 1_000), new Date(now - 1_000))
  await utimes(solRollout, new Date(now), new Date(now))

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.syncNow(['codex'])
    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.externalSessionId, terraId)
    assert.equal(codex?.model, 'gpt-5.6-terra')
    assert.equal(codex?.reasoningEffort, 'ultra')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService start() resolves after first disk hydrate', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-start-')
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const sessionId = '019f7001-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/ready-before-window'
  const rollout = join(sessions, `rollout-2026-07-14T12-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd, model: 'gpt-5.3-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 64000, output_tokens: 10, total_tokens: 64010 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 12,
              window_minutes: 10080,
              resets_at: Date.now() / 1000 + 3600,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(rollout, new Date(), new Date())

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.start()
    const codex = hub.snapshot().agents.find((a) => a.agentType === 'codex')
    assert.ok(codex, 'start() should leave hub hydrated before resolve')
    assert.ok((codex?.token?.contextUsedPercent ?? 0) > 20)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService ignores dormant Codex rollouts and closed CLI', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-dormant-')
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const liveId = '019f7100-aaaa-bbbb-cccc-ddddeeeeffff'
  const dormantId = '019f7101-aaaa-bbbb-cccc-ddddeeeeffff'
  const liveCwd = 'E:/work/open-cli'
  const dormantCwd = 'E:/work/never-opened-today'
  const liveRollout = join(sessions, `rollout-2026-07-14T12-00-00-${liveId}.jsonl`)
  const dormantRollout = join(sessions, `rollout-2026-07-14T10-00-00-${dormantId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  const body = (id: string, cwd: string) =>
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id, cwd, model: 'gpt-5.3-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 20000, output_tokens: 1, total_tokens: 20001 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 8,
              window_minutes: 10080,
              resets_at: Math.floor(Date.now() / 1000) + 86_400,
            },
          },
        },
      }),
    ].join('\n')

  await writeFile(liveRollout, body(liveId, liveCwd), 'utf8')
  await writeFile(dormantRollout, body(dormantId, dormantCwd), 'utf8')
  await utimes(liveRollout, new Date(), new Date())
  // 20 minutes ago — outside CODEX_LIVE_MS (5m), still inside 48h quota fallback only if alone
  const old = new Date(Date.now() - 20 * 60_000)
  await utimes(dormantRollout, old, old)

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.syncNow()
    const codexAgents = hub.snapshot().agents.filter((a) => a.agentType === 'codex')
    assert.equal(codexAgents.length, 1, 'only live open-CLI project should hydrate')
    assert.equal(codexAgents[0]?.workspacePath?.replace(/\\/g, '/'), liveCwd)
  } finally {
    sync.stop()
  }

  // Closed CLI: even live mtime must not resurrect projects.
  const hub2 = new StatusHub({ sessionThrottleMs: 0 })
  const sync2 = new SessionSyncService({
    hub: hub2,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => false,
  })
  try {
    await sync2.syncNow()
    assert.equal(
      hub2.snapshot().agents.filter((a) => a.agentType === 'codex').length,
      0,
      'no codex process → no project cards from disk',
    )
  } finally {
    sync2.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService hydrates Grok only from live active_sessions', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-grok-')
  const liveId = '019f7002-aaaa-bbbb-cccc-ddddeeeeffff'
  const staleId = '019f7002-bbbb-bbbb-cccc-ddddeeeeffff'
  const liveCwd = 'E:\\work\\grok-open'
  const staleCwd = 'E:\\work\\grok-closed'
  const liveDir = join(home, 'sessions', encodeURIComponent(liveCwd), liveId)
  const staleDir = join(home, 'sessions', encodeURIComponent(staleCwd), staleId)
  const logs = join(home, 'logs')

  await mkdir(liveDir, { recursive: true })
  await mkdir(staleDir, { recursive: true })
  await mkdir(logs, { recursive: true })

  // Only the live session is listed as active (with a living pid).
  await writeFile(
    join(home, 'active_sessions.json'),
    JSON.stringify([{ session_id: liveId, cwd: liveCwd, pid: 42_424 }]),
    'utf8',
  )

  for (const [dir, id, cwd, pct] of [
    [liveDir, liveId, liveCwd, 42],
    [staleDir, staleId, staleCwd, 90],
  ] as const) {
    await writeFile(
      join(dir, 'summary.json'),
      JSON.stringify({ info: { id, cwd }, current_model_id: 'grok-4.5' }),
      'utf8',
    )
    await writeFile(
      join(dir, 'signals.json'),
      JSON.stringify({
        contextWindowUsage: pct,
        contextTokensUsed: 100_000,
        contextWindowTokens: 500_000,
        primaryModelId: 'grok-4.5',
      }),
      'utf8',
    )
  }

  const periodEnd = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString()
  await writeFile(
    join(logs, 'unified.jsonl'),
    JSON.stringify({
      msg: 'billing: fetched credits config',
      ctx: {
        subscriptionTier: 'SuperGrok',
        config: {
          creditUsagePercent: 18,
          billingPeriodEnd: periodEnd,
          currentPeriod: { type: 'week', end: periodEnd },
        },
      },
    }) + '\n',
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: home,
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    isPidAlive: (pid) => pid === 42_424,
  })

  try {
    await sync.syncNow()
    const grokAgents = hub.snapshot().agents.filter((a) => a.agentType === 'grok')
    // One live project (not the stale disk-only session).
    assert.equal(grokAgents.length, 1)
    assert.equal(grokAgents[0]?.workspacePath?.replace(/\\/g, '/'), liveCwd.replace(/\\/g, '/'))
    assert.equal(grokAgents[0]?.token?.contextUsedPercent, 42)
    assert.equal(grokAgents[0]?.token?.rateLimits?.sevenDay?.usedPercent, 18)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService skips Grok active_sessions with dead pid', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-grok-dead-')
  const sessionId = '019f7004-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:\\work\\grok-dead-pid'
  const sessionDir = join(home, 'sessions', encodeURIComponent(cwd), sessionId)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(home, 'active_sessions.json'),
    JSON.stringify([{ session_id: sessionId, cwd, pid: 9_999_991 }]),
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'summary.json'),
    JSON.stringify({ info: { id: sessionId, cwd }, current_model_id: 'grok-4.5' }),
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'signals.json'),
    JSON.stringify({
      contextWindowUsage: 55,
      contextTokensUsed: 100_000,
      contextWindowTokens: 500_000,
      primaryModelId: 'grok-4.5',
    }),
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: home,
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    isPidAlive: () => false,
  })

  try {
    await sync.syncNow()
    assert.equal(
      hub.snapshot().agents.filter((a) => a.agentType === 'grok').length,
      0,
      'dead pid must not hydrate a project card',
    )
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService hydrates Claude from live sessions pid + transcript', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-claude-')
  const sessionId = '0e5de746-68eb-49f7-a119-2a869bf38864'
  const cwd = 'E:\\work\\claude-open'
  const sessionsDir = join(home, 'sessions')
  const projectDir = join(home, 'projects', 'E-------work-claude-open')
  const transcript = join(projectDir, `${sessionId}.jsonl`)

  await mkdir(sessionsDir, { recursive: true })
  await mkdir(projectDir, { recursive: true })
  await writeFile(join(home, 'settings.json'), JSON.stringify({ effortLevel: 'high' }), 'utf8')
  await writeFile(
    join(sessionsDir, '424242.json'),
    JSON.stringify({
      pid: 424_242,
      sessionId,
      cwd,
      status: 'idle',
      updatedAt: Date.now(),
    }),
    'utf8',
  )
  await writeFile(
    transcript,
    [
      JSON.stringify({ type: 'mode', mode: 'normal', sessionId }),
      JSON.stringify({
        type: 'assistant',
        cwd,
        sessionId,
        message: {
          model: 'claude-opus-4',
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40_000,
            cache_creation_input_tokens: 500,
            output_tokens: 200,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: home,
    disableWatch: true,
    isPidAlive: (pid) => pid === 424_242,
  })

  try {
    await sync.syncNow()
    const claude = hub.snapshot().agents.find((a) => a.agentType === 'claude_code')
    assert.ok(claude, 'expected claude_code agent after disk sync')
    assert.equal(claude?.workspacePath?.replace(/\\/g, '/'), cwd.replace(/\\/g, '/'))
    assert.equal(claude?.model, 'claude-opus-4')
    assert.equal(claude?.reasoningEffort, 'high')
    // contextInput = 100+40000+500 = 40600 / 200000 ≈ 20.3%
    assert.ok(
      (claude?.token?.contextUsedPercent ?? 0) > 15,
      `expected context % from transcript usage, got ${claude?.token?.contextUsedPercent}`,
    )

    // A parsed settings file that no longer defines effort is an authoritative
    // unknown value, rather than a reason to keep the previous level forever.
    await writeFile(join(home, 'settings.json'), JSON.stringify({ model: 'opus' }), 'utf8')
    await sync.syncNow(['claude_code'])
    const refreshed = hub.snapshot().agents.find((a) => a.agentType === 'claude_code')
    assert.equal(refreshed?.reasoningEffort, undefined)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService skips Claude sessions with dead pid', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-claude-dead-')
  const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const cwd = 'E:\\work\\claude-dead'
  await mkdir(join(home, 'sessions'), { recursive: true })
  await writeFile(
    join(home, 'sessions', '999991.json'),
    JSON.stringify({
      pid: 999_991,
      sessionId,
      cwd,
      status: 'idle',
      updatedAt: Date.now(),
    }),
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: home,
    disableWatch: true,
    isPidAlive: () => false,
  })

  try {
    await sync.syncNow()
    assert.equal(
      hub.snapshot().agents.filter((a) => a.agentType === 'claude_code').length,
      0,
      'dead claude pid must not hydrate a project card',
    )
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService skips unchanged fingerprint on second scan', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-fp-')
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const sessionId = '019f7003-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/fp-dedupe'
  const rollout = join(sessions, `rollout-2026-07-14T12-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd, model: 'gpt-5.3-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 10000, output_tokens: 1, total_tokens: 10001 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 5,
              window_minutes: 10080,
              resets_at: Math.floor(Date.now() / 1000) + 86_400,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(rollout, new Date(), new Date())

  let eventCount = 0
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  hub.on('event', () => {
    eventCount += 1
  })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.syncNow()
    const afterFirst = eventCount
    assert.ok(afterFirst >= 2, 'first scan should emit session_start + token_snapshot')
    await sync.syncNow()
    assert.equal(eventCount, afterFirst, 'second scan with same mtime/token must not re-ingest')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService can scan only the dirty source', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-source-')
  const codexHome = join(home, 'codex')
  const claudeHome = join(home, 'claude')
  const codexSessions = join(codexHome, 'sessions', '2026', '07', '16')
  const codexSessionId = '019f7004-aaaa-bbbb-cccc-ddddeeeeffff'
  const claudeSessionId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
  const rollout = join(codexSessions, `rollout-2026-07-16-${codexSessionId}.jsonl`)

  await mkdir(codexSessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: codexSessionId, cwd: 'E:/work/dirty-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(rollout, new Date(), new Date())
  await mkdir(join(claudeHome, 'sessions'), { recursive: true })
  await writeFile(
    join(claudeHome, 'sessions', '515151.json'),
    JSON.stringify({
      pid: 515_151,
      sessionId: claudeSessionId,
      cwd: 'E:/work/clean-claude',
      updatedAt: Date.now(),
    }),
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome,
    grokHome: join(home, 'no-grok'),
    claudeHome,
    disableWatch: true,
    codexProcessAlive: () => true,
    isPidAlive: () => true,
  })

  try {
    await sync.syncNow(['codex'])
    assert.deepEqual(
      hub.snapshot().agents.map((agent) => agent.agentType),
      ['codex'],
    )

    await sync.syncNow(['claude_code'])
    assert.deepEqual(
      hub
        .snapshot()
        .agents.map((agent) => agent.agentType)
        .sort(),
      ['claude_code', 'codex'],
    )
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService shares highest same-window weekly % across projects (not stale mtime)', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-quota-share-')
  const sessions = join(home, 'sessions', '2026', '07', '15')
  const futureReset = Math.floor(Date.now() / 1000) + 86_400
  const staleId = '019f8000-aaaa-bbbb-cccc-ddddeeeeff01'
  const freshId = '019f8000-aaaa-bbbb-cccc-ddddeeeeff02'
  const sparkId = '019f8000-aaaa-bbbb-cccc-ddddeeeeff03'
  const staleCwd = 'E:/work/stale-2pct'
  const freshCwd = 'E:/work/fresh-35pct'
  const sparkCwd = 'E:/work/spark-0pct'

  await mkdir(sessions, { recursive: true })

  async function writeRollout(
    sessionId: string,
    cwd: string,
    usedPercent: number,
    limitId: string,
    limitName: string | null,
    mtimeOffsetSec: number,
  ) {
    const file = join(sessions, `rollout-2026-07-15T12-00-00-${sessionId}.jsonl`)
    await writeFile(
      file,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd, model: 'gpt-5.3-codex' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 256000,
              last_token_usage: { input_tokens: 1000, output_tokens: 1, total_tokens: 1001 },
            },
            rate_limits: {
              limit_id: limitId,
              ...(limitName ? { limit_name: limitName } : {}),
              primary: {
                used_percent: usedPercent,
                window_minutes: 10080,
                resets_at: futureReset,
              },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    )
    const t = new Date(Date.now() + mtimeOffsetSec * 1000)
    await utimes(file, t, t)
  }

  // Freshest mtime is Spark 0% — must NOT win over main weekly 35%.
  await writeRollout(staleId, staleCwd, 2, 'codex', null, -30)
  await writeRollout(freshId, freshCwd, 35, 'codex', null, -10)
  await writeRollout(sparkId, sparkCwd, 0, 'codex_bengalfox', 'GPT-5.3-Codex-Spark', 0)

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  try {
    await sync.syncNow()
    const agents = hub.snapshot().agents.filter((a) => a.agentType === 'codex')
    assert.ok(agents.length >= 2, `expected multiple codex projects, got ${agents.length}`)
    for (const agent of agents) {
      // Shared main weekly — even the project whose own file only had 2%.
      assert.equal(
        agent.token?.rateLimits?.sevenDay?.usedPercent,
        35,
        `${agent.workspacePath} should show shared 35% weekly, not stale/spark`,
      )
    }
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('StatusHub does not let same-window weekly % go backwards from stale snapshots', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const future = Math.floor(Date.now() / 1000) + 86_400

  hub.ingest({
    id: 'high',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/work/a',
    timestamp: 100,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 35, resetsAt: future, windowMinutes: 10_080 },
      },
    },
  })
  hub.ingest({
    id: 'stale-low',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/work/a',
    timestamp: 200,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 2, resetsAt: future, windowMinutes: 10_080 },
      },
    },
  })

  const codex = hub.snapshot().agents.find((a) => a.agentType === 'codex')
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 35)
})

test('StatusHub keeps soft-reset 0% on expired window against stale high %', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const past = Math.floor(Date.now() / 1000) - 3_600

  hub.ingest({
    id: 'soft-zero',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/work/reset',
    timestamp: 100,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 0, resetsAt: past, windowMinutes: 10_080 },
      },
    },
  })
  hub.ingest({
    id: 'stale-pre-reset',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/work/reset',
    timestamp: 200,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 88, resetsAt: past, windowMinutes: 10_080 },
      },
    },
  })

  const codex = hub.snapshot().agents.find((a) => a.agentType === 'codex')
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 0)
})

async function mkdtempJoin(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), prefix))
}

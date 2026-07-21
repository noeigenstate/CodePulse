import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { TurnState } from '@codepulse/shared'
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

test('SessionSyncService synchronizes Codex native active and completed task timing', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-codex-timing-')
  const sessions = join(home, 'sessions', '2026', '07', '16')
  const sessionId = '019f7009-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/codex-timing'
  const rollout = join(sessions, `rollout-2026-07-16T12-00-00-${sessionId}.jsonl`)
  const completedStartSeconds = Math.floor(Date.now() / 1000) - 20
  const completedAtSeconds = completedStartSeconds + 4

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
      JSON.stringify({
        timestamp: new Date((completedStartSeconds - 30) * 1000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_started',
          started_at: completedStartSeconds - 30,
        },
      }),
      JSON.stringify({
        timestamp: new Date(completedStartSeconds * 1000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-complete',
          started_at: completedStartSeconds,
        },
      }),
      JSON.stringify({
        timestamp: new Date(completedAtSeconds * 1000).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn-complete',
          completed_at: completedAtSeconds,
          duration_ms: 4_321,
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
    await sync.syncNow(['codex'])
    let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.deepEqual(codex?.turnTiming, {
      state: 'completed',
      externalTurnId: 'turn-complete',
      startedAt: completedStartSeconds * 1000,
      elapsedMs: 4_321,
      observedAt: completedAtSeconds * 1000,
    })
    assert.equal(
      codex?.state,
      TurnState.IDLE,
      'an unidentified historical start must not revive a completed Codex task',
    )

    const activeStartSeconds = completedAtSeconds + 1
    await writeFile(
      rollout,
      [
        JSON.stringify({
          timestamp: new Date((activeStartSeconds - 1) * 1000).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'turn-after-terminal-earlier',
            started_at: activeStartSeconds - 1,
          },
        }),
        JSON.stringify({
          timestamp: new Date(activeStartSeconds * 1000).toISOString(),
          type: 'event_msg',
          payload: { type: 'task_started', turn_id: 'turn-active', started_at: activeStartSeconds },
        }),
      ]
        .map((line) => `\n${line}`)
        .join(''),
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(rollout, new Date(), new Date())
    await sync.syncNow(['codex'])

    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.deepEqual(codex?.turnTiming, {
      state: 'active',
      externalTurnId: 'turn-active',
      startedAt: activeStartSeconds * 1000,
      observedAt: activeStartSeconds * 1000,
    })
    assert.equal(codex?.turnStartedAt, activeStartSeconds * 1000)
    assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)

    // A fresh server process has no hook memory. The native active snapshot
    // must still recover a running card. A static record is not a heartbeat;
    // only a later real rollout write refreshes the watchdog timestamp.
    let restartNow = Date.now()
    const restartedHub = new StatusHub({ sessionThrottleMs: 0 })
    const restartedSync = new SessionSyncService({
      hub: restartedHub,
      userHome: home,
      codexHome: home,
      grokHome: join(home, 'no-grok'),
      claudeHome: join(home, 'no-claude'),
      disableWatch: true,
      now: () => restartNow,
      codexProcessAlive: () => true,
    })
    try {
      await restartedSync.syncNow(['codex'])
      let restored = restartedHub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      assert.equal(restored?.state, TurnState.PROMPT_SUBMITTED)
      assert.equal(restored?.terminalAt, undefined)
      const restoredAt = restored?.lastEventAt

      restartNow += 3_500
      await restartedSync.syncNow(['codex'])
      restored = restartedHub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      assert.equal(restored?.lastEventAt, restoredAt)
      assert.equal(restored?.terminalAt, undefined)

      await writeFile(
        rollout,
        `\n${JSON.stringify({ type: 'event_msg', payload: { type: 'progress' } })}`,
        { encoding: 'utf8', flag: 'a' },
      )
      await utimes(rollout, new Date(restartNow), new Date(restartNow))
      await restartedSync.syncNow(['codex'])
      restored = restartedHub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      assert.equal(restored?.lastEventAt, restartNow)
    } finally {
      restartedSync.stop()
    }
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService validates Codex native terminal timing against the root turn', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-codex-root-turn-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const sessionId = '019f8000-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/codex-root-turn'
  const rollout = join(sessions, `rollout-2026-07-20T12-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: { last_token_usage: { input_tokens: 100, total_tokens: 100 } },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(rollout, new Date(), new Date())

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
  })

  /** Appends native Codex lifecycle rows and forces a new file revision. */
  const appendLifecycleRows = async (
    rows: Array<{ timestamp: number; payload: Record<string, unknown> }>,
  ): Promise<void> => {
    await writeFile(
      rollout,
      rows
        .map(({ timestamp, payload }) =>
          JSON.stringify({
            timestamp: new Date(timestamp).toISOString(),
            type: 'event_msg',
            payload,
          }),
        )
        .map((line) => `\n${line}`)
        .join(''),
      { encoding: 'utf8', flag: 'a' },
    )
    const revision = rows.at(-1)?.timestamp ?? Date.now()
    const changedAt = new Date(Date.now() + (revision % 10_000))
    await utimes(rollout, changedAt, changedAt)
  }

  /** Appends one paired native Codex task and its terminal outcome. */
  const appendTask = async (
    turnId: string,
    outcome: 'task_complete' | 'turn_aborted',
    startedAt: number,
  ): Promise<void> => {
    const completedAt = startedAt + 1_000
    await appendLifecycleRows([
      {
        timestamp: startedAt,
        payload: { type: 'task_started', turn_id: turnId, started_at: startedAt / 1_000 },
      },
      {
        timestamp: completedAt,
        payload: {
          type: outcome,
          turn_id: turnId,
          completed_at: completedAt / 1_000,
          duration_ms: 1_000,
        },
      },
    ])
  }

  try {
    const rootStartedAt = Date.now()
    await appendLifecycleRows([
      {
        timestamp: rootStartedAt,
        payload: {
          type: 'task_started',
          turn_id: 'root-a',
          started_at: rootStartedAt / 1_000,
        },
      },
    ])
    await appendTask('nested-b', 'task_complete', rootStartedAt + 1_000)
    await sync.syncNow(['codex'])
    let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)
    assert.equal(codex?.externalTurnId, 'root-a')
    assert.equal(notifications.length, 0)

    hub.ingest({
      id: 'root-a-stop',
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: sessionId,
      externalTurnId: 'root-a',
      cwd,
      timestamp: rootStartedAt + 3_000,
    })
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.DONE)
    assert.equal(notifications.length, 1)

    await appendLifecycleRows([
      {
        timestamp: rootStartedAt + 3_000,
        payload: {
          type: 'task_complete',
          turn_id: 'root-a',
          completed_at: (rootStartedAt + 3_000) / 1_000,
          duration_ms: 3_000,
        },
      },
    ])
    await sync.syncNow(['codex'])
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]?.dedupeKey.startsWith('done:'), true)

    hub.ingest({
      id: 'root-c-prompt',
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: sessionId,
      externalTurnId: 'root-c',
      cwd,
      timestamp: rootStartedAt + 5_000,
    })
    await appendTask('root-c', 'turn_aborted', rootStartedAt + 6_000)
    await sync.syncNow(['codex'])
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.CANCELLED)
    assert.equal(notifications.length, 1, 'cancelled turns must not emit a completion toast')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService never lets a Codex subagent rollout end the root turn', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-codex-subagent-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const rootSessionId = '019f8100-aaaa-bbbb-cccc-ddddeeeeffff'
  const childThreadId = '019f8101-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/codex-subagent'
  const rootRollout = join(sessions, `rollout-root-${rootSessionId}.jsonl`)
  const childRollout = join(sessions, `rollout-child-${childThreadId}.jsonl`)
  const rootStartedAt = Date.now() - 2_000
  const childStartedAt = rootStartedAt + 500

  await mkdir(sessions, { recursive: true })
  await writeFile(
    childRollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: childThreadId,
          session_id: rootSessionId,
          cwd,
          // Put the only child-lineage marker beyond the normal 512 KiB head.
          padding: 'x'.repeat(600_000),
          forked_from_id: rootSessionId,
        },
      }),
      JSON.stringify({
        timestamp: new Date(rootStartedAt).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'root-a', started_at: rootStartedAt / 1_000 },
      }),
      JSON.stringify({
        timestamp: new Date(childStartedAt).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'child-b',
          started_at: childStartedAt / 1_000,
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(childRollout, new Date(), new Date())

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
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
    let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.externalSessionId, rootSessionId)
    assert.equal(codex?.externalTurnId, undefined)
    assert.equal(codex?.state, TurnState.IDLE)
    assert.equal(notifications.length, 0)

    await writeFile(
      rootRollout,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: rootSessionId, session_id: rootSessionId, cwd },
        }),
        JSON.stringify({
          timestamp: new Date(rootStartedAt).toISOString(),
          type: 'event_msg',
          payload: {
            type: 'task_started',
            turn_id: 'root-a',
            started_at: rootStartedAt / 1_000,
          },
        }),
      ].join('\n'),
      'utf8',
    )
    await utimes(rootRollout, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000))
    await sync.syncNow(['codex'])
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)
    assert.equal(codex?.externalTurnId, 'root-a')
    assert.equal(notifications.length, 0)

    const childCompletedAt = childStartedAt + 1_000
    await writeFile(
      childRollout,
      `\n${JSON.stringify({
        timestamp: new Date(childCompletedAt).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'child-b',
          completed_at: childCompletedAt / 1_000,
          duration_ms: 1_000,
        },
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(childRollout, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000))
    await sync.syncNow(['codex'])
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)
    assert.equal(codex?.externalTurnId, 'root-a')
    assert.equal(notifications.length, 0)

    const rootCompletedAt = rootStartedAt + 4_000
    await writeFile(
      rootRollout,
      `\n${JSON.stringify({
        timestamp: new Date(rootCompletedAt).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'root-a',
          completed_at: rootCompletedAt / 1_000,
          duration_ms: 4_000,
        },
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(rootRollout, new Date(Date.now() + 3_000), new Date(Date.now() + 3_000))
    await sync.syncNow(['codex'])
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.DONE)
    assert.equal(notifications.length, 1)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService keeps a user-created Codex fork as a root rollout', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-codex-user-fork-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const parentSessionId = '019f8200-aaaa-bbbb-cccc-ddddeeeeffff'
  const forkSessionId = '019f8201-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/codex-user-fork'
  const rollout = join(sessions, `rollout-user-fork-${forkSessionId}.jsonl`)
  const startedAt = Date.now() - 1_000

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: forkSessionId,
          session_id: forkSessionId,
          cwd,
          thread_source: 'user',
          forked_from_id: parentSessionId,
        },
      }),
      JSON.stringify({
        timestamp: new Date(startedAt).toISOString(),
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'fork-root-a', started_at: startedAt / 1_000 },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(rollout, new Date(), new Date())

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
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
    let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.externalSessionId, forkSessionId)
    assert.equal(codex?.externalTurnId, 'fork-root-a')
    assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)

    const completedAt = startedAt + 1_000
    await writeFile(
      rollout,
      `\n${JSON.stringify({
        timestamp: new Date(completedAt).toISOString(),
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'fork-root-a',
          completed_at: completedAt / 1_000,
          duration_ms: 1_000,
        },
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(rollout, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000))
    await sync.syncNow(['codex'])
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, TurnState.DONE)
    assert.equal(notifications.length, 1)
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
  const grokTurnStartedAt = Date.now() - 5_000
  const grokTurnEndedAt = grokTurnStartedAt + 3_250

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
  await writeFile(
    join(liveDir, 'events.jsonl'),
    [
      JSON.stringify({
        type: 'turn_started',
        ts: new Date(grokTurnStartedAt).toISOString(),
      }),
      JSON.stringify({
        type: 'turn_ended',
        ts: new Date(grokTurnEndedAt).toISOString(),
      }),
    ].join('\n'),
    'utf8',
  )

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
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
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
    assert.deepEqual(grokAgents[0]?.turnTiming, {
      state: 'completed',
      startedAt: grokTurnStartedAt,
      elapsedMs: 3_250,
      observedAt: grokTurnEndedAt,
    })

    const rootTurnId = 'grok-root-a'
    const nestedTurnId = 'grok-nested-b'
    const rootStartedAt = Date.now()
    hub.ingest({
      id: 'grok-root-prompt',
      source: 'grok',
      eventType: 'prompt_submit',
      externalSessionId: liveId,
      externalTurnId: rootTurnId,
      cwd: liveCwd,
      timestamp: rootStartedAt,
    })
    const eventsFile = join(liveDir, 'events.jsonl')
    const nestedStartedAt = rootStartedAt + 100
    const nestedEndedAt = nestedStartedAt + 500
    await writeFile(
      eventsFile,
      [
        JSON.stringify({
          type: 'turn_started',
          turn_id: nestedTurnId,
          ts: new Date(nestedStartedAt).toISOString(),
        }),
        JSON.stringify({
          type: 'turn_ended',
          turn_id: nestedTurnId,
          ts: new Date(nestedEndedAt).toISOString(),
        }),
      ]
        .map((line) => `\n${line}`)
        .join(''),
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(eventsFile, new Date(Date.now() + 1_000), new Date(Date.now() + 1_000))
    await sync.syncNow(['grok'])
    let grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
    assert.equal(grok?.state, TurnState.PROMPT_SUBMITTED)
    assert.equal(grok?.externalTurnId, rootTurnId)
    assert.equal(notifications.length, 0)

    const rootEndedAt = rootStartedAt + 1_000
    await writeFile(
      eventsFile,
      [
        JSON.stringify({
          type: 'turn_started',
          turn_id: rootTurnId,
          ts: new Date(rootStartedAt).toISOString(),
        }),
        JSON.stringify({
          type: 'turn_ended',
          turn_id: rootTurnId,
          ts: new Date(rootEndedAt).toISOString(),
        }),
      ]
        .map((line) => `\n${line}`)
        .join(''),
      { encoding: 'utf8', flag: 'a' },
    )
    await utimes(eventsFile, new Date(Date.now() + 2_000), new Date(Date.now() + 2_000))
    await sync.syncNow(['grok'])
    grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
    assert.equal(grok?.state, TurnState.DONE)
    assert.equal(notifications.length, 1)
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
  const promptAt = Date.now() - 6_000
  const completedAt = promptAt + 4_000

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
        type: 'user',
        timestamp: new Date(promptAt).toISOString(),
        userType: 'external',
        message: { role: 'user' },
      }),
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
      JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        timestamp: new Date(completedAt).toISOString(),
        durationMs: 4_000,
      }),
    ].join('\n'),
    'utf8',
  )

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
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
    assert.deepEqual(claude?.turnTiming, {
      state: 'completed',
      startedAt: promptAt,
      elapsedMs: 4_000,
      observedAt: completedAt,
    })
    // contextInput = 100+40000+500 = 40600 / 200000 ≈ 20.3%
    assert.ok(
      (claude?.token?.contextUsedPercent ?? 0) > 15,
      `expected context % from transcript usage, got ${claude?.token?.contextUsedPercent}`,
    )

    // Claude has no common turn ID here. A later external user row that cannot
    // be reconciled with `turn_duration` must not be attached as this turn's
    // start, while the native completed duration remains displayable.
    const mismatchedCompletedAt = Date.now() - 500
    await writeFile(
      transcript,
      [
        JSON.stringify({
          type: 'user',
          timestamp: new Date(mismatchedCompletedAt - 855).toISOString(),
          userType: 'external',
          message: { role: 'user' },
        }),
        JSON.stringify({
          type: 'system',
          subtype: 'turn_duration',
          timestamp: new Date(mismatchedCompletedAt).toISOString(),
          durationMs: 592_873,
        }),
      ]
        .map((line) => `\n${line}`)
        .join(''),
      { encoding: 'utf8', flag: 'a' },
    )
    await sync.syncNow(['claude_code'])
    const unpairedClaude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
    assert.deepEqual(unpairedClaude?.turnTiming, {
      state: 'completed',
      canEndActiveTurn: false,
      elapsedMs: 592_873,
      observedAt: mismatchedCompletedAt,
    })

    const activePromptAt = Date.now()
    await writeFile(
      join(sessionsDir, '424242.json'),
      JSON.stringify({
        pid: 424_242,
        sessionId,
        cwd,
        status: 'busy',
        startedAt: promptAt - 60_000,
        updatedAt: activePromptAt,
      }),
      'utf8',
    )
    await writeFile(
      transcript,
      `\n${JSON.stringify({
        type: 'user',
        timestamp: new Date(activePromptAt).toISOString(),
        userType: 'external',
        message: { role: 'user' },
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await sync.syncNow(['claude_code'])
    const activeClaude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
    assert.deepEqual(activeClaude?.turnTiming, {
      state: 'active',
      startedAt: activePromptAt,
      observedAt: activePromptAt,
    })

    const sidechainDurationAt = activePromptAt + 500
    await writeFile(
      transcript,
      `\n${JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        isSidechain: true,
        timestamp: new Date(sidechainDurationAt).toISOString(),
        durationMs: 500,
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await sync.syncNow(['claude_code'])
    const afterSidechainClaude = hub
      .snapshot()
      .agents.find((agent) => agent.agentType === 'claude_code')
    assert.equal(afterSidechainClaude?.state, TurnState.PROMPT_SUBMITTED)
    assert.deepEqual(afterSidechainClaude?.turnTiming, {
      state: 'active',
      startedAt: activePromptAt,
      observedAt: activePromptAt,
    })

    const unrelatedDurationAt = activePromptAt + 1_000
    await writeFile(
      transcript,
      `\n${JSON.stringify({
        type: 'system',
        subtype: 'turn_duration',
        timestamp: new Date(unrelatedDurationAt).toISOString(),
        durationMs: 592_873,
      })}`,
      { encoding: 'utf8', flag: 'a' },
    )
    await sync.syncNow(['claude_code'])
    const stillActiveClaude = hub
      .snapshot()
      .agents.find((agent) => agent.agentType === 'claude_code')
    assert.equal(stillActiveClaude?.state, TurnState.PROMPT_SUBMITTED)
    assert.deepEqual(stillActiveClaude?.turnTiming, {
      state: 'active',
      startedAt: activePromptAt,
      observedAt: activePromptAt,
    })
    assert.equal(notifications.length, 0)

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

test('SessionSyncService reuses unchanged Codex rollout parses and invalidates changed files', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-rollout-cache-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const sessionId = '019fa003-aaaa-bbbb-cccc-ddddeeeeffff'
  const rollout = join(sessions, `rollout-2026-07-20-${sessionId}.jsonl`)
  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'E:/work/cached-rollout' },
    }),
    'utf8',
  )

  let parseCount = 0
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: () => true,
    codexRolloutReader: async () => {
      parseCount += 1
      return {
        model: 'gpt-5.6-terra',
        modelObservedAt: Date.now(),
        token: {
          contextWindow: 256_000,
          contextUsedPercent: 10,
          accuracy: 'estimated',
        },
      }
    },
  })

  try {
    await sync.syncNow(['codex'])
    await sync.syncNow(['codex'])
    assert.equal(parseCount, 1, 'unchanged rollout should reuse its parsed snapshot')

    const changedAt = new Date(Date.now() + 2_000)
    await utimes(rollout, changedAt, changedAt)
    await sync.syncNow(['codex'])
    assert.equal(parseCount, 2, 'mtime change should invalidate the parsed snapshot')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService throttles Claude account quota resolution across steady scans', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-claude-quota-cache-')
  let resolveCount = 0
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    claudeQuotaResolver: async () => {
      resolveCount += 1
      return {
        rateLimits: {
          sevenDay: {
            usedPercent: 12,
            resetsAt: Math.floor(Date.now() / 1000) + 86_400,
            windowMinutes: 10_080,
          },
        },
        updatedAt: Date.now(),
        source: 'oauth',
      }
    },
  })

  try {
    await sync.syncNow(['claude_code'])
    await sync.syncNow(['claude_code'])
    assert.equal(resolveCount, 1, 'quota endpoint should run at most once per cache interval')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService retains Claude quota when a later refresh is unavailable', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-claude-quota-expiry-')
  let now = Date.now()
  const observedAt = now
  let authenticated = true
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({
    hub,
    now: () => now,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    claudeQuotaResolver: async () =>
      authenticated
        ? {
            rateLimits: {
              sevenDay: {
                usedPercent: 18,
                resetsAt: Math.floor(observedAt / 1000) + 7 * 86_400,
                windowMinutes: 10_080,
              },
            },
            updatedAt: observedAt,
            source: 'oauth',
          }
        : undefined,
  })

  try {
    await sync.syncNow(['claude_code'])
    let claude = hub.snapshot(now).agents.find((agent) => agent.agentType === 'claude_code')
    assert.equal(claude?.token?.rateLimits?.sevenDay?.usedPercent, 18)

    authenticated = false
    now += 11 * 60_000
    await sync.syncNow(['claude_code'])
    claude = hub.snapshot(now).agents.find((agent) => agent.agentType === 'claude_code')
    assert.equal(claude?.token?.rateLimits?.sevenDay?.usedPercent, 18)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService coalesces refreshes requested during an active scan', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-coalesced-')
  let releaseFirstScan!: () => void
  let releaseSecondScan!: () => void
  let markFirstScanStarted!: () => void
  let markSecondScanStarted!: () => void
  const firstScanGate = new Promise<void>((resolve) => {
    releaseFirstScan = resolve
  })
  const secondScanGate = new Promise<void>((resolve) => {
    releaseSecondScan = resolve
  })
  const firstScanStarted = new Promise<void>((resolve) => {
    markFirstScanStarted = resolve
  })
  const secondScanStarted = new Promise<void>((resolve) => {
    markSecondScanStarted = resolve
  })
  let processChecks = 0
  const sync = new SessionSyncService({
    hub: new StatusHub({ sessionThrottleMs: 0 }),
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    disableWatch: true,
    codexProcessAlive: async () => {
      processChecks += 1
      if (processChecks === 1) {
        markFirstScanStarted()
        await firstScanGate
      } else if (processChecks === 2) {
        markSecondScanStarted()
        await secondScanGate
      }
      return false
    },
  })

  try {
    const first = sync.syncNow(['codex'])
    await firstScanStarted
    const second = sync.syncNow(['codex'])
    const third = sync.syncNow(['codex'])
    releaseFirstScan()
    await first
    await secondScanStarted
    let trailingResolved = false
    void second.then(() => {
      trailingResolved = true
    })
    await Promise.resolve()
    assert.equal(trailingResolved, false, 'trailing callers must await their own generation')
    releaseSecondScan()
    await Promise.all([second, third])
    assert.equal(processChecks, 2, 'overlapping requests should share one trailing scan')
  } finally {
    releaseFirstScan()
    releaseSecondScan()
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
  const futureSeconds = Math.floor(Date.now() / 1000) + 86_400
  // These resets straddle the old five-minute rounding boundary by two seconds.
  const resetBeforeBoundary = Math.floor(futureSeconds / 300) * 300 + 149
  const resetAfterBoundary = resetBeforeBoundary + 2
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
    resetsAt: number,
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
                resets_at: resetsAt,
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
  await writeRollout(staleId, staleCwd, 2, 'codex', null, -30, resetAfterBoundary)
  await writeRollout(freshId, freshCwd, 35, 'codex', null, -10, resetBeforeBoundary)
  await writeRollout(
    sparkId,
    sparkCwd,
    0,
    'codex_bengalfox',
    'GPT-5.3-Codex-Spark',
    0,
    resetAfterBoundary,
  )

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

test('SessionSyncService keeps same-window Codex quota stable as live rollouts rotate', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-quota-rotation-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const highId = '019fa100-aaaa-bbbb-cccc-ddddeeeeff01'
  const lowId = '019fa100-aaaa-bbbb-cccc-ddddeeeeff02'
  const highPath = join(sessions, `rollout-2026-07-20-${highId}.jsonl`)
  const lowPath = join(sessions, `rollout-2026-07-20-${lowId}.jsonl`)
  const firstReset = Math.floor(Date.now() / 1000) + 86_400
  const nextReset = firstReset + 7 * 24 * 60 * 60
  await mkdir(sessions, { recursive: true })

  /** Writes one minimal Codex quota rollout for the requested account window. */
  async function writeQuotaRollout(
    path: string,
    sessionId: string,
    cwd: string,
    usedPercent: number,
    resetsAt: number,
  ): Promise<void> {
    await writeFile(
      path,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: sessionId, cwd } }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              model_context_window: 256000,
              last_token_usage: { input_tokens: 1_000, total_tokens: 1_000 },
            },
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    )
  }

  await writeQuotaRollout(highPath, highId, 'E:/work/quota-high', 35, firstReset)
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

    const staleAt = new Date(Date.now() - 10 * 60_000)
    await utimes(highPath, staleAt, staleAt)
    await writeQuotaRollout(lowPath, lowId, 'E:/work/quota-low', 2, firstReset)
    await sync.syncNow(['codex'])
    let low = hub.snapshot().agents.find((agent) => agent.workspacePath === 'E:/work/quota-low')
    assert.equal(low?.token?.rateLimits?.sevenDay?.usedPercent, 35)

    await writeQuotaRollout(lowPath, lowId, 'E:/work/quota-low', 2, nextReset)
    const changedAt = new Date(Date.now() + 2_000)
    await utimes(lowPath, changedAt, changedAt)
    await sync.syncNow(['codex'])
    low = hub.snapshot().agents.find((agent) => agent.workspacePath === 'E:/work/quota-low')
    assert.equal(low?.token?.rateLimits?.sevenDay?.usedPercent, 35)
    for (let confirmation = 0; confirmation < 4; confirmation += 1) {
      await sync.syncNow(['codex'])
    }
    low = hub.snapshot().agents.find((agent) => agent.workspacePath === 'E:/work/quota-low')
    assert.equal(low?.token?.rateLimits?.sevenDay?.usedPercent, 2)
    assert.equal(low?.token?.rateLimits?.sevenDay?.resetsAt, nextReset)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService rebinds an unchanged Codex quota to its newer rollout source', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-quota-rebind-')
  const sessions = join(home, 'sessions', '2026', '07', '20')
  const projectId = '019fa200-aaaa-bbbb-cccc-ddddeeeeff01'
  const firstQuotaId = '019fa200-aaaa-bbbb-cccc-ddddeeeeff02'
  const secondQuotaId = '019fa200-aaaa-bbbb-cccc-ddddeeeeff03'
  const projectPath = join(sessions, `rollout-2026-07-20-${projectId}.jsonl`)
  const firstQuotaPath = join(sessions, `rollout-2026-07-20-${firstQuotaId}.jsonl`)
  const secondQuotaPath = join(sessions, `rollout-2026-07-20-${secondQuotaId}.jsonl`)
  const resetAt = Math.floor(Date.now() / 1000) + 6 * 86_400
  await mkdir(sessions, { recursive: true })
  await writeFile(
    projectPath,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: projectId, cwd: 'E:/work/quota-rebind-project' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 2_000, total_tokens: 2_000 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  /** Writes an account-quota rollout whose displayed values remain unchanged. */
  async function writeQuotaSource(path: string, sessionId: string): Promise<void> {
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd: `E:/work/${sessionId}` },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: { last_token_usage: { input_tokens: 1_000, total_tokens: 1_000 } },
            rate_limits: {
              limit_id: 'codex',
              primary: { used_percent: 24, window_minutes: 10080, resets_at: resetAt },
            },
          },
        }),
      ].join('\n'),
      'utf8',
    )
  }

  await writeQuotaSource(firstQuotaPath, firstQuotaId)
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const projectQuotaPaths: Array<string | undefined> = []
  hub.on('event', (event) => {
    if (event.eventType === 'token_snapshot' && event.externalSessionId === projectId) {
      projectQuotaPaths.push(event.tokenSourcePath)
    }
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
    await sync.syncNow(['codex'])
    assert.equal(projectQuotaPaths.at(-1), firstQuotaPath)

    await writeQuotaSource(secondQuotaPath, secondQuotaId)
    const newer = new Date(Date.now() + 2_000)
    await utimes(secondQuotaPath, newer, newer)
    await sync.syncNow(['codex'])
    assert.equal(projectQuotaPaths.at(-1), secondQuotaPath)
    assert.equal(projectQuotaPaths.length, 2, 'source change should emit one quota-only rebind')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService keeps Codex weekly quota from a parallel same-workspace rollout', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-parallel-quota-')
  const sessions = join(home, 'sessions', '2026', '07', '17')
  const cwd = 'E:/work/parallel-codex'
  const quotaId = '019f9000-aaaa-bbbb-cccc-ddddeeeeff01'
  const modelId = '019f9000-aaaa-bbbb-cccc-ddddeeeeff02'
  const futureReset = Math.floor(Date.now() / 1000) + 5 * 24 * 60 * 60
  const olderModelAt = new Date(Date.now() - 60_000).toISOString()
  const newerModelAt = new Date().toISOString()
  await mkdir(sessions, { recursive: true })

  const quotaRollout = join(sessions, `rollout-2026-07-17T01-00-00-${quotaId}.jsonl`)
  await writeFile(
    quotaRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: quotaId, cwd } }),
      JSON.stringify({
        timestamp: olderModelAt,
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol', effort: 'high' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 20_000, output_tokens: 10, total_tokens: 20_010 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 42,
              window_minutes: 10080,
              resets_at: futureReset,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  const modelRollout = join(sessions, `rollout-2026-07-17T01-01-00-${modelId}.jsonl`)
  await writeFile(
    modelRollout,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: modelId, cwd } }),
      JSON.stringify({
        timestamp: newerModelAt,
        type: 'turn_context',
        payload: { model: 'gpt-5.6-terra', effort: 'max' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 30_000, output_tokens: 20, total_tokens: 30_020 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  const now = new Date()
  await utimes(quotaRollout, now, now)
  await utimes(modelRollout, now, now)

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
    const agents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
    assert.equal(agents.length, 1)
    assert.equal(agents[0]?.model, 'gpt-5.6-terra')
    assert.equal(agents[0]?.token?.contextUsedPercent, (30_000 / 256_000) * 100)
    assert.equal(agents[0]?.token?.rateLimits?.sevenDay?.usedPercent, 42)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService quota fallback skips a newer rollout without rate limits', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-quota-fallback-')
  const sessions = join(home, 'sessions', '2026', '07', '17')
  const quotaId = '019f9100-aaaa-bbbb-cccc-ddddeeeeff01'
  const emptyId = '019f9100-aaaa-bbbb-cccc-ddddeeeeff02'
  const futureReset = Math.floor(Date.now() / 1000) + 4 * 24 * 60 * 60
  await mkdir(sessions, { recursive: true })

  const quotaRollout = join(sessions, `rollout-2026-07-17T00-00-00-${quotaId}.jsonl`)
  await writeFile(
    quotaRollout,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1_000, total_tokens: 1_010 } },
        rate_limits: {
          limit_id: 'codex',
          primary: {
            used_percent: 31,
            window_minutes: 10080,
            resets_at: futureReset,
          },
        },
      },
    }),
    'utf8',
  )

  const emptyRollout = join(sessions, `rollout-2026-07-17T00-01-00-${emptyId}.jsonl`)
  await writeFile(
    emptyRollout,
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 2_000, total_tokens: 2_010 } },
      },
    }),
    'utf8',
  )

  const idleAt = Date.now() - 10 * 60_000
  await utimes(quotaRollout, new Date(idleAt - 1_000), new Date(idleAt - 1_000))
  await utimes(emptyRollout, new Date(idleAt), new Date(idleAt))

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
    assert.ok(codex)
    assert.equal(codex?.workspacePath, undefined)
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 31)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService hydrates Kimi model, effort, context, and native timing', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-kimi-')
  const sessionId = 'session_kimi_sync'
  const cwd = 'E:/work/kimi-open'
  const sessionDir = join(home, 'sessions', 'wd_kimi', sessionId)
  const agentDir = join(sessionDir, 'agents', 'main')
  const wirePath = join(agentDir, 'wire.jsonl')
  const promptAt = Date.now() - 4_000
  const stepAt = promptAt + 20
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId, sessionDir, workDir: cwd })}\n`,
    'utf8',
  )
  await writeFile(
    wirePath,
    [
      JSON.stringify({ type: 'turn.prompt', time: promptAt }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin' },
        time: stepAt,
      }),
      JSON.stringify({
        type: 'llm.request',
        modelAlias: 'kimi-code/k3',
        thinkingEffort: 'max',
        maxTokens: 150_000,
        time: stepAt + 1,
      }),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 1_000, inputCacheRead: 49_000, inputCacheCreation: 0, output: 300 },
        time: stepAt + 2,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.end' },
        time: stepAt + 3,
      }),
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin' },
        time: stepAt + 4,
      }),
      JSON.stringify({
        type: 'llm.request',
        modelAlias: 'kimi-code/k3',
        thinkingEffort: 'max',
        maxTokens: 149_700,
        time: stepAt + 5,
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
    claudeHome: join(home, 'no-claude'),
    kimiHome: home,
    kimiProcessAlive: () => true,
    kimiQuotaResolver: async () => ({
      rateLimits: {
        fiveHour: { usedPercent: 100, resetsAt: 1_800_000_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 20, resetsAt: 1_800_604_800, windowMinutes: 10_080 },
      },
      updatedAt: Date.now(),
      source: 'api',
    }),
    disableWatch: true,
  })
  try {
    await sync.syncNow(['kimi'])
    const kimi = hub.snapshot().agents.find((agent) => agent.agentType === 'kimi')
    assert.ok(kimi)
    assert.equal(kimi?.model, 'kimi-code/k3')
    assert.equal(kimi?.reasoningEffort, 'max')
    assert.equal(kimi?.token?.input, 50_000)
    assert.equal(kimi?.token?.contextWindow, 200_000)
    assert.equal(kimi?.token?.contextUsedPercent, 25.15)
    assert.equal(kimi?.token?.rateLimits?.fiveHour?.usedPercent, 100)
    assert.equal(kimi?.token?.rateLimits?.sevenDay?.usedPercent, 20)
    assert.deepEqual(kimi?.turnTiming, {
      state: 'active',
      startedAt: promptAt,
      observedAt: stepAt + 4,
    })
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('SessionSyncService does not treat a Kimi step.end as whole-turn completion', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-kimi-step-')
  const sessionId = 'session_kimi_multi_step'
  const cwd = 'E:/work/kimi-multi-step'
  const sessionDir = join(home, 'sessions', 'wd_kimi', sessionId)
  const agentDir = join(sessionDir, 'agents', 'main')
  const wirePath = join(agentDir, 'wire.jsonl')
  const promptAt = Date.now() - 1_000
  const stepAt = promptAt + 20
  const activeRows = [
    JSON.stringify({ type: 'turn.prompt', time: promptAt }),
    JSON.stringify({
      type: 'context.append_loop_event',
      event: { type: 'step.begin' },
      time: stepAt,
    }),
  ]
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId, sessionDir, workDir: cwd })}\n`,
    'utf8',
  )
  await writeFile(wirePath, activeRows.join('\n'), 'utf8')

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: Array<{ dedupeKey: string }> = []
  hub.on('notification', (notification) => notifications.push(notification))
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: join(home, 'no-codex'),
    grokHome: join(home, 'no-grok'),
    claudeHome: join(home, 'no-claude'),
    kimiHome: home,
    kimiProcessAlive: () => true,
    kimiQuotaResolver: async () => undefined,
    disableWatch: true,
  })

  try {
    await sync.syncNow(['kimi'])
    let kimi = hub.snapshot().agents.find((agent) => agent.agentType === 'kimi')
    assert.equal(kimi?.state, TurnState.PROMPT_SUBMITTED)

    await writeFile(
      wirePath,
      [
        ...activeRows,
        JSON.stringify({
          type: 'context.append_loop_event',
          event: { type: 'step.end' },
          time: stepAt + 100,
        }),
      ].join('\n'),
      'utf8',
    )
    const changedAt = new Date(Date.now() + 1_000)
    await utimes(wirePath, changedAt, changedAt)
    await sync.syncNow(['kimi'])

    kimi = hub.snapshot().agents.find((agent) => agent.agentType === 'kimi')
    assert.equal(kimi?.state, TurnState.PROMPT_SUBMITTED)
    assert.equal(notifications.length, 0)

    hub.ingest({
      id: 'kimi-real-stop',
      source: 'kimi',
      eventType: 'turn_stop',
      externalSessionId: sessionId,
      cwd,
      timestamp: stepAt + 200,
    })
    assert.equal(notifications.length, 1)
    assert.equal(notifications[0]?.dedupeKey.startsWith('done:'), true)
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

test('StatusHub accepts a higher official reading immediately after a zero sample', () => {
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
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 88)
})

async function mkdtempJoin(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), prefix))
}

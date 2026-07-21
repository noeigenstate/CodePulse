import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STUCK_STRONG_MS, STUCK_VISIBLE_MS, StatusHub } from '@codepulse/core'
import { type AgentEvent, type NotificationRequest, TurnState } from '@codepulse/shared'
import { fromClaudeHook } from '@codepulse/adapters'
import {
  buildAgentPanels,
  buildWorkspaceAgentGroups,
  collectQuotaMeters,
  latestQuotaToken,
} from '../apps/desktop/src/renderer/src/lib/displayAgents.js'

test('StatusHub keeps the same agent separated by workspace', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'a-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: 100,
  })
  hub.ingest({
    id: 'b-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-b',
    cwd: 'E:/project/b',
    timestamp: 200,
  })

  const codexAgents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
  assert.equal(codexAgents.length, 2)
  assert.deepEqual(codexAgents.map((agent) => agent.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/b',
  ])
})

test('StatusHub routes workspace-less events back to the original session workspace', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: 100,
  })
  hub.ingest({
    id: 'stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'session-a',
    message: 'done',
    timestamp: 200,
  })

  const codexAgents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
  assert.equal(codexAgents.length, 1)
  assert.equal(codexAgents[0]?.workspacePath, 'E:/project/a')
  assert.equal(codexAgents[0]?.state, 'DONE')
})

test('StatusHub freezes elapsed time after a terminal lifecycle event', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const finishedAt = startedAt + 12_345

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: finishedAt,
  })

  const codex = hub.snapshot(finishedAt).agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.turnStartedAt, undefined)
  assert.deepEqual(codex?.turnTiming, {
    state: 'completed',
    startedAt,
    elapsedMs: 12_345,
    observedAt: finishedAt,
  })
})

test('StatusHub restores a native active timing snapshot without using scan time', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const nativeStartedAt = 1_000_000

  hub.ingest({
    id: 'disk-timing',
    source: 'claude_code',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: nativeStartedAt + 90_000,
    turnTiming: {
      state: 'active',
      startedAt: nativeStartedAt,
      observedAt: nativeStartedAt,
    },
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.turnStartedAt, nativeStartedAt)
  assert.deepEqual(claude?.turnTiming, {
    state: 'active',
    startedAt: nativeStartedAt,
    observedAt: nativeStartedAt,
  })
})

test('StatusHub ignores a stale native timing snapshot after a newer prompt hook', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const staleStartedAt = 1_000_000
  const currentStartedAt = staleStartedAt + 10_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: currentStartedAt,
  })
  hub.ingest({
    id: 'stale-disk-timing',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: currentStartedAt + 1_000,
    turnTiming: {
      state: 'completed',
      elapsedMs: 2_000,
      observedAt: staleStartedAt + 5_000,
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.turnStartedAt, currentStartedAt)
  assert.deepEqual(codex?.turnTiming, {
    state: 'active',
    startedAt: currentStartedAt,
    observedAt: currentStartedAt,
  })
})

test('StatusHub keeps the root turn identity when a stale foreign timing is rejected', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  hub.ingest({
    id: 'root-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'timing-identity-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/timing-identity',
    timestamp: 2_000,
  })
  hub.ingest({
    id: 'root-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'timing-identity-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/timing-identity',
    timestamp: 3_000,
  })
  const completedTiming = hub
    .snapshot()
    .agents.find((agent) => agent.agentType === 'codex')?.turnTiming

  hub.ingest({
    id: 'stale-foreign-active',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'timing-identity-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timing-identity',
    timestamp: 4_000,
    turnTiming: {
      state: 'active',
      externalTurnId: 'nested-b',
      startedAt: 1_000,
      observedAt: 1_000,
    },
    internal: { sessionSync: true },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.DONE)
  assert.equal(codex?.externalTurnId, 'root-a')
  assert.deepEqual(codex?.turnTiming, completedTiming)
  assert.equal(notifications.length, 1)
})

test('StatusHub does not let an unpaired Claude duration end an active turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  hub.ingest({
    id: 'claude-prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'claude-unpaired-session',
    cwd: 'E:/project/claude-unpaired',
    timestamp: 10_000,
  })
  hub.ingest({
    id: 'claude-unpaired-duration',
    source: 'claude_code',
    eventType: 'token_snapshot',
    externalSessionId: 'claude-unpaired-session',
    cwd: 'E:/project/claude-unpaired',
    timestamp: 20_000,
    turnTiming: {
      state: 'completed',
      canEndActiveTurn: false,
      elapsedMs: 592_873,
      observedAt: 19_000,
    },
    internal: { sessionSync: true },
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.state, TurnState.PROMPT_SUBMITTED)
  assert.deepEqual(claude?.turnTiming, {
    state: 'active',
    startedAt: 10_000,
    observedAt: 10_000,
  })
  assert.equal(notifications.length, 0)
})

test('StatusHub does not let a late task ID claim an ID-less root prompt', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  hub.ingest({
    id: 'idless-root-prompt',
    source: 'grok',
    eventType: 'prompt_submit',
    externalSessionId: 'idless-native-session',
    cwd: 'E:/project/idless-native',
    timestamp: 10_000,
  })
  hub.ingest({
    id: 'nested-native-completion',
    source: 'grok',
    eventType: 'token_snapshot',
    externalSessionId: 'idless-native-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/idless-native',
    timestamp: 11_100,
    turnTiming: {
      state: 'completed',
      externalTurnId: 'nested-b',
      startedAt: 10_000,
      elapsedMs: 1_000,
      observedAt: 11_000,
    },
    internal: { sessionSync: true },
  })

  const grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
  assert.equal(grok?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(grok?.externalTurnId, undefined)
  assert.equal(notifications.length, 0)
})

test('StatusHub accepts only the matching native completion for an active root turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  const base = {
    source: 'grok' as const,
    externalSessionId: 'grok-root-session',
    cwd: 'E:/project/grok-root',
  }
  hub.ingest({
    ...base,
    id: 'root-prompt',
    eventType: 'prompt_submit',
    externalTurnId: 'root-a',
    timestamp: 10_000,
  })
  hub.ingest({
    ...base,
    id: 'nested-completion',
    eventType: 'token_snapshot',
    externalTurnId: 'nested-b',
    timestamp: 12_000,
    turnTiming: {
      state: 'completed',
      externalTurnId: 'nested-b',
      startedAt: 10_500,
      elapsedMs: 1_000,
      observedAt: 11_500,
    },
    internal: { sessionSync: true },
  })

  let grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
  assert.equal(grok?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(grok?.externalTurnId, 'root-a')
  assert.equal(notifications.length, 0)

  hub.ingest({
    ...base,
    id: 'anonymous-completion',
    eventType: 'token_snapshot',
    timestamp: 12_500,
    turnTiming: {
      state: 'completed',
      startedAt: 11_000,
      elapsedMs: 1_000,
      observedAt: 12_000,
    },
    internal: { sessionSync: true },
  })
  grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
  assert.equal(grok?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(grok?.externalTurnId, 'root-a')
  assert.equal(notifications.length, 0)

  hub.ingest({
    ...base,
    id: 'root-completion',
    eventType: 'token_snapshot',
    externalTurnId: 'root-a',
    timestamp: 13_000,
    turnTiming: {
      state: 'completed',
      externalTurnId: 'root-a',
      startedAt: 10_000,
      elapsedMs: 2_500,
      observedAt: 12_500,
    },
    internal: { sessionSync: true },
  })

  grok = hub.snapshot().agents.find((agent) => agent.agentType === 'grok')
  assert.equal(grok?.state, TurnState.DONE)
  assert.equal(notifications.length, 1)
})

test('StatusHub accepts a delayed native terminal snapshot for the matching root ID', () => {
  for (const outcome of ['completed', 'cancelled'] as const) {
    const hub = new StatusHub({ sessionThrottleMs: 0 })
    const notifications: NotificationRequest[] = []
    hub.on('notification', (notification) => notifications.push(notification))

    hub.ingest({
      id: `${outcome}-prompt`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: `${outcome}-session`,
      externalTurnId: `${outcome}-root`,
      cwd: 'E:/project/delayed-terminal',
      timestamp: 2_000,
    })
    hub.ingest({
      id: `${outcome}-native-terminal`,
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: `${outcome}-session`,
      externalTurnId: `${outcome}-root`,
      cwd: 'E:/project/delayed-terminal',
      timestamp: 2_100,
      turnTiming: {
        state: 'completed',
        externalTurnId: `${outcome}-root`,
        outcome,
        startedAt: 1_500,
        elapsedMs: 490,
        observedAt: 1_990,
      },
      internal: { sessionSync: true },
    })

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.state, outcome === 'cancelled' ? TurnState.CANCELLED : TurnState.DONE)
    assert.equal(notifications.length, outcome === 'completed' ? 1 : 0)
  }
})

test('StatusHub lets native completion duration refine the same hook-observed turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const hookStoppedAt = startedAt + 5_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: hookStoppedAt,
  })
  hub.ingest({
    id: 'native-completion',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: hookStoppedAt + 1_000,
    turnTiming: {
      state: 'completed',
      startedAt,
      elapsedMs: 4_321,
      observedAt: startedAt + 4_321,
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.deepEqual(codex?.turnTiming, {
    state: 'completed',
    startedAt,
    elapsedMs: 4_321,
    observedAt: startedAt + 4_321,
  })
})

test('StatusHub backfills a nearby CLI completion even when no prompt association is safe', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const hookStoppedAt = startedAt + 5_000

  hub.ingest({
    id: 'prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'stop',
    source: 'claude_code',
    eventType: 'turn_stop',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: hookStoppedAt,
  })
  hub.ingest({
    id: 'native-unpaired-completion',
    source: 'claude_code',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: hookStoppedAt + 1_000,
    turnTiming: {
      state: 'completed',
      elapsedMs: 4_321,
      observedAt: startedAt + 4_321,
    },
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.deepEqual(claude?.turnTiming, {
    state: 'completed',
    elapsedMs: 4_321,
    observedAt: startedAt + 4_321,
  })
})

test('StatusHub only revives a timeout after a real local-session activity refresh', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const timeoutAt = startedAt + STUCK_VISIBLE_MS + 1

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt)

  const staleTiming = {
    state: 'active' as const,
    startedAt,
    observedAt: startedAt,
  }
  hub.ingest({
    id: 'static-disk-record',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: timeoutAt + 1,
    turnTiming: staleTiming,
    internal: { sessionSync: true },
  })
  assert.equal(
    hub.snapshot().agents.find((agent) => agent.agentType === 'codex')?.state,
    TurnState.TIMEOUT,
  )

  hub.ingest({
    id: 'fresh-disk-record',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'elapsed-session',
    cwd: 'E:/project/elapsed',
    timestamp: timeoutAt + 2,
    turnTiming: staleTiming,
    internal: { sessionSync: true, activityRefresh: true },
  })
  assert.equal(
    hub.snapshot().agents.find((agent) => agent.agentType === 'codex')?.state,
    TurnState.PROMPT_SUBMITTED,
  )
})

test('StatusHub does not let a foreign task take over after the root times out', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000
  const timeoutAt = startedAt + STUCK_VISIBLE_MS + 1

  hub.ingest({
    id: 'root-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/timeout-root',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt)

  hub.ingest({
    id: 'foreign-active',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timeout-root',
    timestamp: timeoutAt + 1,
    turnTiming: {
      state: 'active',
      externalTurnId: 'nested-b',
      startedAt: timeoutAt + 1,
      observedAt: timeoutAt + 1,
    },
    internal: { sessionSync: true, activityRefresh: true },
  })
  hub.ingest({
    id: 'foreign-completed',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timeout-root',
    timestamp: timeoutAt + 2,
    turnTiming: {
      state: 'completed',
      externalTurnId: 'nested-b',
      startedAt: timeoutAt + 1,
      elapsedMs: 1_000,
      observedAt: timeoutAt + 1_001,
    },
    internal: { sessionSync: true, activityRefresh: true },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.TIMEOUT)
  assert.equal(codex?.externalTurnId, 'root-a')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.dedupeKey.startsWith('stuck:'), true)

  hub.ingest({
    id: 'foreign-session-start',
    source: 'codex',
    eventType: 'session_start',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timeout-root',
    timestamp: timeoutAt + 2,
  })
  let afterDirectHook = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(afterDirectHook?.state, TurnState.TIMEOUT)
  assert.equal(afterDirectHook?.externalTurnId, 'root-a')

  hub.ingest({
    id: 'foreign-tool-start',
    source: 'codex',
    eventType: 'tool_start',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timeout-root',
    toolName: 'Agent',
    timestamp: timeoutAt + 3,
  })
  hub.ingest({
    id: 'foreign-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'nested-b',
    cwd: 'E:/project/timeout-root',
    timestamp: timeoutAt + 4,
  })
  afterDirectHook = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(afterDirectHook?.state, TurnState.TOOL_RUNNING)
  assert.equal(afterDirectHook?.externalTurnId, 'root-a')
  assert.equal(notifications.length, 1)

  hub.ingest({
    id: 'root-stop-after-timeout',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'timeout-root-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/timeout-root',
    timestamp: timeoutAt + 5,
  })
  afterDirectHook = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(afterDirectHook?.state, TurnState.DONE)
  assert.equal(notifications.length, 2)
  assert.equal(notifications[1]?.dedupeKey.startsWith('done:'), true)
})

test('StatusHub lets fresh matching-root activity recover a timed-out turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000
  const timeoutAt = startedAt + STUCK_VISIBLE_MS + 1

  hub.ingest({
    id: 'root-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'matching-timeout-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/matching-timeout',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt)
  hub.ingest({
    id: 'matching-root-resumed',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'matching-timeout-session',
    externalTurnId: 'root-a',
    cwd: 'E:/project/matching-timeout',
    timestamp: timeoutAt + 1,
    turnTiming: {
      state: 'active',
      externalTurnId: 'root-a',
      startedAt,
      observedAt: timeoutAt + 1,
    },
    internal: { sessionSync: true, activityRefresh: true },
  })

  const resumed = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(resumed?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(resumed?.externalTurnId, 'root-a')
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.dedupeKey.startsWith('stuck:'), true)
})

test('StatusHub keeps the newest Codex model and thinking-depth snapshot atomic', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const base = {
    source: 'codex' as const,
    eventType: 'token_snapshot' as const,
    externalSessionId: 'model-session',
    cwd: 'E:/project/model-config',
  }

  hub.ingest({
    ...base,
    id: 'terra-ultra',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'ultra',
    modelObservedAt: 2_000,
    timestamp: 5_000,
  })
  // A later unversioned hook event may still contain an old top-level model.
  hub.ingest({
    ...base,
    id: 'late-sol-hook',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    timestamp: 6_000,
  })

  let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.model, 'gpt-5.6-terra')
  assert.equal(codex?.reasoningEffort, 'ultra')

  hub.ingest({
    ...base,
    id: 'new-sol-max',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    modelObservedAt: 3_000,
    timestamp: 7_000,
  })
  hub.ingest({
    ...base,
    id: 'terra-effort-unknown',
    model: 'gpt-5.6-terra',
    modelObservedAt: 4_000,
    timestamp: 8_000,
  })

  codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.model, 'gpt-5.6-terra')
  assert.equal(codex?.reasoningEffort, undefined)
  assert.equal(codex?.modelObservedAt, 4_000)
})

test('StatusHub applies and clears Claude thinking-depth settings by observation time', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const base = {
    source: 'claude_code' as const,
    eventType: 'token_snapshot' as const,
    externalSessionId: 'claude-thinking-session',
    cwd: 'E:/project/claude-thinking',
    model: 'claude-opus-4-8',
  }

  hub.ingest({
    ...base,
    id: 'settings-high',
    reasoningEffort: 'high',
    reasoningEffortObservedAt: 2_000,
    timestamp: 5_000,
  })
  // A late unversioned hook cannot replace a depth confirmed by settings.json.
  hub.ingest({
    ...base,
    id: 'late-hook',
    reasoningEffort: 'low',
    timestamp: 6_000,
  })
  hub.ingest({
    ...base,
    id: 'settings-cleared',
    reasoningEffortObservedAt: 3_000,
    timestamp: 7_000,
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.reasoningEffort, undefined)
  assert.equal(claude?.reasoningEffortObservedAt, 3_000)
})

test('StatusHub keeps one card when the same session reports subdirectory cwd values', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-root',
    cwd: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe',
    timestamp: 100,
  })
  hub.ingest({
    id: 'tool-sub-a',
    source: 'claude_code',
    eventType: 'tool_start',
    externalSessionId: 'session-root',
    cwd: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern/results',
    toolName: 'Bash',
    timestamp: 200,
  })
  hub.ingest({
    id: 'tool-sub-b',
    source: 'claude_code',
    eventType: 'tool_start',
    externalSessionId: 'session-root',
    cwd: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern_classifi',
    toolName: 'Read',
    timestamp: 300,
  })

  const claudeAgents = hub.snapshot().agents.filter((agent) => agent.agentType === 'claude_code')
  assert.equal(claudeAgents.length, 1)
  assert.equal(claudeAgents[0]?.state, TurnState.TOOL_RUNNING)
  assert.equal(claudeAgents[0]?.workspacePath, 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe')
})

test('display panels collapse nested workspace cards into the project root', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 100,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe',
    },
    {
      agentType: 'claude_code',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 2,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 200,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern/results',
    },
    {
      agentType: 'claude_code',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 3,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 300,
      workspacePath: 'E:/共形项目/zsy_pipe_network/gitlab_single_pipe/flow_pattern_classifi',
    },
  ])

  assert.equal(panels.length, 1)
  assert.equal(panels[0]?.workspaces.length, 1)
  assert.equal(
    panels[0]?.workspaces[0]?.workspacePath,
    'E:/共形项目/zsy_pipe_network/gitlab_single_pipe',
  )
  assert.equal(panels[0]?.workspaces[0]?.agent.state, TurnState.TOOL_RUNNING)
  assert.equal(panels[0]?.workspaces[0]?.name, 'gitlab_single_pipe')
})

test('display panels do not collapse Desktop projects under the user profile path', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 100,
      workspacePath: 'C:\\Users\\Administrator',
      model: 'gpt-5.6-sol',
    },
    {
      agentType: 'codex',
      state: TurnState.TOOL_RUNNING,
      toolCallCount: 2,
      needPermission: false,
      needUserInput: false,
      unread: false,
      lastEventAt: 500,
      workspacePath:
        'C:\\Users\\Administrator\\Desktop\\MetalMax_recovered_from_recycle_bin_20260708',
      model: 'gpt-5.6-sol',
    },
  ])

  assert.equal(panels.length, 1)
  const names = panels[0]?.workspaces.map((w) => w.name).sort() ?? []
  assert.deepEqual(names, ['Administrator', 'MetalMax_recovered_from_recycle_bin_20260708'])
  const metal = panels[0]?.workspaces.find((w) => w.name.startsWith('MetalMax'))
  assert.ok(metal)
  assert.match(
    metal?.workspacePath?.replace(/\\/g, '/') ?? '',
    /Desktop\/MetalMax_recovered_from_recycle_bin_20260708$/i,
  )
  assert.equal(metal?.agent.state, TurnState.TOOL_RUNNING)
})

test('display panels keep the newest verified model config for duplicate workspace sessions', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      externalSessionId: 'sol-session',
      workspacePath: 'E:/project/model-selection',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'max',
      modelObservedAt: 2_000,
      lastEventAt: 9_000,
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      unread: false,
      externalSessionId: 'terra-session',
      workspacePath: 'E:/project/model-selection',
      model: 'gpt-5.6-terra',
      reasoningEffort: 'ultra',
      modelObservedAt: 3_000,
      lastEventAt: 1_000,
    },
  ])

  const card = panels.find((panel) => panel.agentType === 'codex')?.workspaces[0]?.agent
  assert.equal(card?.model, 'gpt-5.6-terra')
  assert.equal(card?.reasoningEffort, 'ultra')
})

test('StatusHub treats slash and backslash workspace paths as the same project', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:\\project\\a',
    timestamp: 100,
  })
  hub.ingest({
    id: 'token',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: { contextUsedPercent: 12, accuracy: 'estimated' },
  })

  const codexAgents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
  assert.equal(codexAgents.length, 1)
  assert.equal(codexAgents[0]?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(codexAgents[0]?.token?.contextUsedPercent, 12)
})

test('StatusHub freezes elapsed time when watchdog marks TIMEOUT', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_VISIBLE_MS + 1)

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.TIMEOUT)
  assert.equal(codex?.turnStartedAt, undefined)
  assert.deepEqual(codex?.turnTiming, {
    state: 'completed',
    startedAt,
    elapsedMs: STUCK_VISIBLE_MS + 1,
    observedAt: startedAt + STUCK_VISIBLE_MS + 1,
  })
})

test('StatusHub emits a synthetic timeout event through the normal pipeline', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const events: AgentEvent[] = []
  hub.on('event', (event) => events.push(event))
  const startedAt = 1_000_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    externalTurnId: 'turn-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_VISIBLE_MS + 1)

  const timeout = events.find((event) => event.eventType === 'turn_timeout')
  assert.equal(timeout?.source, 'codex')
  assert.equal(timeout?.externalSessionId, 'session-a')
  assert.equal(timeout?.externalTurnId, 'turn-a')
  assert.equal(timeout?.cwd, 'E:/project/a')
})

test('Claude session limit notification pauses the current task', () => {
  const event = fromClaudeHook({
    source: 'claude_code',
    hook_event_name: 'Notification',
    session_id: 'session-a',
    cwd: 'E:/project/a',
    model: 'Opus 4.8',
    message:
      "You've hit your session limit · resets 2:50pm (Asia/Shanghai). /upgrade to increase your usage limit.",
  })

  assert.equal(event?.eventType, 'usage_limited')
  assert.equal(event?.message?.includes('session limit'), true)
})

test('Claude idle input reminder is ignored after a completed turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const finishedAt = startedAt + 1_000
  const reminder = fromClaudeHook({
    source: 'claude_code',
    hook_event_name: 'Notification',
    session_id: 'session-a',
    cwd: 'E:/project/a',
    message: 'Claude is waiting for your input',
  })

  assert.equal(reminder, null)

  hub.ingest({
    id: 'prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'stop',
    source: 'claude_code',
    eventType: 'turn_stop',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: finishedAt,
  })

  const claude = hub
    .snapshot(finishedAt + 60_000)
    .agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.state, TurnState.DONE)
  assert.equal(hub.snapshot(finishedAt + 60_000).overall, 'done_unread')
})

test('Claude unknown notifications are ignored instead of becoming user-input waits', () => {
  assert.equal(
    fromClaudeHook({
      source: 'claude_code',
      hook_event_name: 'Notification',
      session_id: 'session-a',
      cwd: 'E:/project/a',
      message: 'Claude Code login successful',
    }),
    null,
  )
})

test('Claude permission notifications still request attention', () => {
  const event = fromClaudeHook({
    source: 'claude_code',
    hook_event_name: 'Notification',
    session_id: 'session-a',
    cwd: 'E:/project/a',
    message: 'Claude needs permission to run this tool. Approve or deny.',
  })

  assert.equal(event?.eventType, 'permission_request')
})

test('StatusHub shows usage limit instead of processing after Claude quota stops a task', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const limitedAt = startedAt + 1_000

  hub.ingest({
    id: 'prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'Opus 4.8',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'limit',
    source: 'claude_code',
    eventType: 'usage_limited',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'Opus 4.8',
    message:
      "You've hit your session limit · resets 2:50pm (Asia/Shanghai). /upgrade to increase your usage limit.",
    timestamp: limitedAt,
  })

  const snapshot = hub.snapshot(limitedAt)
  const claude = snapshot.agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(snapshot.overall, 'limited')
  assert.equal(claude?.state, TurnState.USAGE_LIMITED)
  assert.equal(claude?.activity, '已达用量上限，任务暂时停止')
  assert.equal(claude?.turnStartedAt, undefined)
})

test('StatusHub removes completed projects after five minutes', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const finishedAt = startedAt + 1_000
  const doneRetentionMs = 5 * 60_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: finishedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(finishedAt + doneRetentionMs - 1)
  assert.equal(hub.snapshot(finishedAt + doneRetentionMs - 1).agents.length, 1)
  ;(hub as unknown as { tick(now?: number): void }).tick(finishedAt + doneRetentionMs)
  assert.equal(hub.snapshot(finishedAt + doneRetentionMs).agents.length, 0)
})

test('StatusHub removes idle projects after five minutes', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const idleAt = startedAt + 1_000
  const idleRetentionMs = 5 * 60_000

  hub.ingest({
    id: 'start',
    source: 'claude_code',
    eventType: 'session_start',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'end',
    source: 'claude_code',
    eventType: 'session_end',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: idleAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(idleAt + idleRetentionMs - 1)
  assert.equal(hub.snapshot(idleAt + idleRetentionMs - 1).agents[0]?.state, TurnState.IDLE)
  ;(hub as unknown as { tick(now?: number): void }).tick(idleAt + idleRetentionMs)
  assert.equal(hub.snapshot(idleAt + idleRetentionMs).agents.length, 0)
})

test('StatusHub idle retention is not extended by quota-only sessionSync snapshots', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const idleRetentionMs = 5 * 60_000

  hub.ingest({
    id: 'start',
    source: 'codex',
    eventType: 'session_start',
    externalSessionId: 'session-idle',
    cwd: 'E:/project/idle-card',
    timestamp: startedAt,
    internal: { sessionSync: true },
  })
  hub.ingest({
    id: 'token',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-idle',
    cwd: 'E:/project/idle-card',
    timestamp: startedAt + 100,
    token: {
      accuracy: 'estimated',
      rateLimits: {
        sevenDay: { usedPercent: 10, resetsAt: startedAt / 1000 + 86_400, windowMinutes: 10_080 },
      },
    },
    internal: { sessionSync: true },
  })

  // Idle clock starts at last activity (token at +100). Quota-only must not extend it.
  const idleAnchor = startedAt + 100
  hub.ingest({
    id: 'quota-tick',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-idle',
    cwd: 'E:/project/idle-card',
    timestamp: idleAnchor + idleRetentionMs - 1_000,
    token: {
      accuracy: 'estimated',
      rateLimits: {
        sevenDay: { usedPercent: 11, resetsAt: startedAt / 1000 + 86_400, windowMinutes: 10_080 },
      },
    },
    internal: { sessionSync: true, quotaRefresh: true },
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(idleAnchor + idleRetentionMs - 1)
  assert.equal(
    hub.snapshot(idleAnchor + idleRetentionMs - 1).agents.some((a) => !a.taskHidden),
    true,
    'still visible just before 5 minutes',
  )
  ;(hub as unknown as { tick(now?: number): void }).tick(idleAnchor + idleRetentionMs)
  const agents = hub
    .snapshot(idleAnchor + idleRetentionMs)
    .agents.filter((a) => a.agentType === 'codex')
  const visible = agents.filter((a) => !a.taskHidden)
  assert.equal(visible.length, 0, 'idle project must be pruned after 5 minutes')
  // Quota shell may remain as taskHidden when rate limits are retained.
  assert.ok(
    agents.length === 0 || agents.every((a) => a.taskHidden),
    'remaining codex slots must be taskHidden quota shells',
  )
})

test('StatusHub keeps quota visible after removing idle project rows', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const tokenAt = startedAt + 500
  const idleAt = startedAt + 1_000
  const idleRetentionMs = 5 * 60_000

  hub.ingest({
    id: 'start',
    source: 'codex',
    eventType: 'session_start',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'token',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: tokenAt,
    token: {
      accuracy: 'exact',
      rateLimits: {
        fiveHour: { usedPercent: 60, resetsAt: tokenAt + 2 * 60 * 60_000 },
        sevenDay: { usedPercent: 25, resetsAt: tokenAt + 3 * 24 * 60 * 60_000 },
      },
    },
  })
  hub.ingest({
    id: 'end',
    source: 'codex',
    eventType: 'session_end',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: idleAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(idleAt + idleRetentionMs)
  const snapshot = hub.snapshot(idleAt + idleRetentionMs)
  const codexPanel = buildAgentPanels(snapshot.agents).find((panel) => panel.agentType === 'codex')

  assert.equal(snapshot.overall, 'idle')
  assert.equal(codexPanel?.workspaces.length, 0)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 60)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.sevenDay?.usedPercent, 25)
})

test('StatusHub clears stuck projects after ten minutes', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const startedAt = 1_000_000
  const timeoutAt = startedAt + STUCK_VISIBLE_MS
  const timeoutRetentionMs = 10 * 60_000

  hub.ingest({
    id: 'prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt)
  assert.equal(hub.snapshot(timeoutAt).overall, 'stuck')
  assert.equal(hub.snapshot(timeoutAt).agents[0]?.state, TurnState.TIMEOUT)
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt + timeoutRetentionMs - 1)
  assert.equal(hub.snapshot(timeoutAt + timeoutRetentionMs - 1).overall, 'stuck')
  ;(hub as unknown as { tick(now?: number): void }).tick(timeoutAt + timeoutRetentionMs)
  const snapshot = hub.snapshot(timeoutAt + timeoutRetentionMs)
  assert.equal(snapshot.overall, 'idle')
  assert.equal(snapshot.agents.length, 0)
})

test('StatusHub expires error, cancelled, and usage-limited projects', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const terminalAt = 1_000_000

  hub.ingest({
    id: 'error',
    source: 'claude_code',
    eventType: 'turn_error',
    externalSessionId: 'error-session',
    cwd: 'E:/project/error',
    timestamp: terminalAt,
  })
  hub.ingest({
    id: 'cancelled',
    source: 'codex',
    eventType: 'turn_cancelled',
    externalSessionId: 'cancel-session',
    cwd: 'E:/project/cancelled',
    timestamp: terminalAt,
  })
  hub.ingest({
    id: 'limited',
    source: 'claude_code',
    eventType: 'usage_limited',
    externalSessionId: 'limit-session',
    cwd: 'E:/project/limited',
    timestamp: terminalAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(terminalAt + 10 * 60_000)

  const snapshot = hub.snapshot(terminalAt + 10 * 60_000)
  assert.equal(snapshot.overall, 'idle')
  assert.equal(snapshot.agents.length, 0)
})

test('StatusHub does not mark long-running tools as TIMEOUT at the visible threshold', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000

  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: startedAt,
  })
  hub.ingest({
    id: 'tool',
    source: 'codex',
    eventType: 'tool_start',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    toolName: 'shell',
    command: 'pnpm test',
    timestamp: startedAt + 1_000,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_VISIBLE_MS + 2_000)
  let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.TOOL_RUNNING)
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_STRONG_MS + 2_000)
  codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.TIMEOUT)
  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.level, 'strong')
  assert.equal(notifications[0]?.dedupeKey.startsWith('stuck:'), true)
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_STRONG_MS + 3_000)
  assert.equal(notifications.length, 1, 'one stuck turn should notify only once')
})

test('StatusHub keeps permission waits from being marked TIMEOUT by the watchdog', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000

  hub.ingest({
    id: 'permission',
    source: 'claude_code',
    eventType: 'permission_request',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    message: 'waiting for permission',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_STRONG_MS + 1)

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.state, TurnState.WAITING_PERMISSION)
  assert.equal(
    notifications.some((notification) => notification.dedupeKey.startsWith('stuck:')),
    false,
  )
})

test('StatusHub keeps user-input waits from being marked TIMEOUT by the watchdog', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000

  hub.ingest({
    id: 'input',
    source: 'claude_code',
    eventType: 'user_input_required',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    message: 'waiting for user input',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_STRONG_MS + 1)

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.state, TurnState.WAITING_USER_INPUT)
  assert.equal(
    notifications.some((notification) => notification.dedupeKey.startsWith('stuck:')),
    false,
  )
})

test('StatusHub expires abandoned permission waits after a long inactivity window', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  const timeoutEvents: AgentEvent[] = []
  hub.on('event', (event) => {
    if (event.eventType === 'turn_timeout') timeoutEvents.push(event)
  })
  const startedAt = 1_000_000

  hub.ingest({
    id: 'permission',
    source: 'claude_code',
    eventType: 'permission_request',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    message: 'waiting for permission',
    timestamp: startedAt,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + 30 * 60_000 + 1)

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.state, TurnState.TIMEOUT)
  assert.equal(timeoutEvents.length, 1)
  assert.equal(timeoutEvents[0]?.externalSessionId, 'session-a')
})

test('StatusHub marks context snapshots stale at session boundaries', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      contextUsedPercent: 88,
      contextWindow: 1_000_000,
      rateLimits: { fiveHour: { usedPercent: 12, resetsAt: 1_000 } },
      accuracy: 'exact',
    },
  })
  hub.ingest({
    id: 'session-end',
    source: 'claude_code',
    eventType: 'session_end',
    cwd: 'E:/project/a',
    timestamp: 200,
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.token?.contextUsedPercent, 88)
  assert.equal(claude?.token?.contextWindow, 1_000_000)
  assert.equal(claude?.token?.contextStale, true)
  assert.equal(claude?.token?.rateLimits?.fiveHour?.usedPercent, 12)

  hub.ingest({
    id: 'new-token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 300,
    token: { contextUsedPercent: 12, contextWindow: 1_000_000, accuracy: 'exact' },
  })

  const updated = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(updated?.token?.contextStale, false)
})

test('StatusHub only emits notifications for completed or stuck turns', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))
  const startedAt = 1_000_000

  hub.ingest({
    id: 'high-context',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'context-session',
    cwd: 'E:/project/a',
    timestamp: startedAt,
    token: {
      contextUsedPercent: 99,
      rateLimits: { fiveHour: { usedPercent: 98 }, sevenDay: { usedPercent: 90 } },
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'permission',
    source: 'claude_code',
    eventType: 'permission_request',
    externalSessionId: 'permission-session',
    cwd: 'E:/project/a',
    message: 'waiting for permission',
    timestamp: startedAt + 1,
  })
  hub.ingest({
    id: 'prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'running-session',
    externalTurnId: 'turn-a',
    cwd: 'E:/project/a',
    message: '请帮我修复更新超时并优化下载',
    timestamp: startedAt + 2,
  })
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_VISIBLE_MS - 1)

  assert.equal(notifications.length, 0)

  hub.ingest({
    id: 'stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'running-session',
    externalTurnId: 'turn-a',
    cwd: 'E:/project/a',
    message: 'done',
    timestamp: startedAt + STUCK_VISIBLE_MS + 4,
  })

  assert.equal(notifications.length, 1)
  assert.equal(notifications[0]?.level, 'normal')
  assert.equal(notifications[0]?.dedupeKey.startsWith('done:'), true)
  assert.match(notifications[0]?.title ?? '', /a 已完成/)
  assert.match(notifications[0]?.title ?? '', /[💖💕✨🎉🌸🍀💝⭐]/u)
  assert.doesNotMatch(notifications[0]?.title ?? '', /一轮任务|Codex|Claude|Grok/)
  assert.doesNotMatch(notifications[0]?.body ?? '', /Codex|Claude|Grok|一轮任务/)
  // Prompt summary is a complete short line (Chinese ≤15 汉字), not a mid-string cut.
  assert.equal(notifications[0]?.body, '修复更新超时并优化下载')
  assert.ok(
    [...(notifications[0]?.body ?? '')].filter((ch) => /[\u3400-\u9fff]/u.test(ch)).length <= 15,
  )
})

test('StatusHub ignores a Codex Stop from a nested turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  hub.ingest({
    id: 'root-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'nested-session',
    externalTurnId: 'root-turn',
    cwd: 'E:/project/nested',
    timestamp: 1_000,
  })
  hub.ingest({
    id: 'nested-tool',
    source: 'codex',
    eventType: 'tool_start',
    externalSessionId: 'nested-session',
    externalTurnId: 'nested-turn',
    cwd: 'E:/project/nested',
    toolName: 'Agent',
    timestamp: 1_100,
  })
  hub.ingest({
    id: 'nested-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'nested-session',
    externalTurnId: 'nested-turn',
    cwd: 'E:/project/nested',
    timestamp: 1_200,
  })

  let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.externalTurnId, 'root-turn')
  assert.equal(codex?.state, TurnState.TOOL_RUNNING)
  assert.equal(notifications.length, 0)

  hub.ingest({
    id: 'root-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'nested-session',
    externalTurnId: 'root-turn',
    cwd: 'E:/project/nested',
    timestamp: 1_300,
  })
  codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.DONE)
  assert.equal(notifications.length, 1)
})

test('StatusHub does not adopt a nested tool ID after an ID-less prompt', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'idless-prompt',
    source: 'kimi',
    eventType: 'prompt_submit',
    externalSessionId: 'idless-session',
    cwd: 'E:/project/idless',
    timestamp: 1_000,
  })
  hub.ingest({
    id: 'nested-tool',
    source: 'kimi',
    eventType: 'tool_start',
    externalSessionId: 'idless-session',
    externalTurnId: 'tool-call-id',
    cwd: 'E:/project/idless',
    timestamp: 1_100,
  })

  const kimi = hub.snapshot().agents.find((agent) => agent.agentType === 'kimi')
  assert.equal(kimi?.state, TurnState.TOOL_RUNNING)
  assert.equal(kimi?.externalTurnId, undefined)
})

test('StatusHub ignores a Stop when no turn is active', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  hub.ingest({
    id: 'idle-stop',
    source: 'codex',
    eventType: 'turn_stop',
    externalSessionId: 'idle-session',
    externalTurnId: 'orphan-turn',
    cwd: 'E:/project/idle',
    timestamp: 1_000,
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.IDLE)
  assert.equal(notifications.length, 0)
})

test('StatusHub ignores a delayed duplicate session start during an active turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'active-prompt',
    source: 'codex',
    eventType: 'prompt_submit',
    externalSessionId: 'active-session',
    externalTurnId: 'root-turn',
    cwd: 'E:/project/active',
    timestamp: 1_000,
  })
  hub.ingest({
    id: 'late-session-start',
    source: 'codex',
    eventType: 'session_start',
    externalSessionId: 'active-session',
    externalTurnId: 'nested-turn',
    cwd: 'E:/project/active',
    timestamp: 1_100,
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(codex?.externalTurnId, 'root-turn')
})

test('StatusHub does not turn a stronger terminal result into a completion toast', () => {
  const terminalEvents = ['turn_error', 'turn_cancelled', 'usage_limited', 'turn_timeout'] as const

  for (const [index, terminalEvent] of terminalEvents.entries()) {
    const hub = new StatusHub({ sessionThrottleMs: 0 })
    const notifications: NotificationRequest[] = []
    hub.on('notification', (notification) => notifications.push(notification))
    const startedAt = 10_000 + index * 1_000

    hub.ingest({
      id: `${terminalEvent}-prompt`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: `${terminalEvent}-session`,
      externalTurnId: `${terminalEvent}-turn`,
      cwd: 'E:/project/terminal',
      timestamp: startedAt,
    })
    hub.ingest({
      id: terminalEvent,
      source: 'codex',
      eventType: terminalEvent,
      externalSessionId: `${terminalEvent}-session`,
      externalTurnId: `${terminalEvent}-turn`,
      cwd: 'E:/project/terminal',
      timestamp: startedAt + 1,
    })
    hub.ingest({
      id: `${terminalEvent}-late-stop`,
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: `${terminalEvent}-session`,
      externalTurnId: `${terminalEvent}-turn`,
      cwd: 'E:/project/terminal',
      timestamp: startedAt + 2,
    })

    const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.notEqual(codex?.state, TurnState.DONE)
    assert.equal(
      notifications.some((notification) => notification.dedupeKey.startsWith('done:')),
      false,
    )
  }
})

test('StatusHub emits at most one completion notification for one root turn', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  const eventBase = {
    source: 'codex' as const,
    externalSessionId: 'dedupe-session',
    externalTurnId: 'dedupe-turn',
    cwd: 'E:/project/dedupe',
  }
  hub.ingest({
    ...eventBase,
    id: 'dedupe-prompt',
    eventType: 'prompt_submit',
    timestamp: 1_000,
  })
  hub.ingest({ ...eventBase, id: 'dedupe-stop-1', eventType: 'turn_stop', timestamp: 2_000 })
  hub.ingest({
    ...eventBase,
    id: 'dedupe-resume',
    eventType: 'tool_start',
    timestamp: 20 * 60_000,
  })
  hub.ingest({
    ...eventBase,
    id: 'dedupe-stop-2',
    eventType: 'turn_stop',
    timestamp: 20 * 60_000 + 1,
  })

  assert.equal(notifications.length, 1)
})

test('StatusHub applies locale changes to subsequent completion notifications', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, locale: 'en' })
  const notifications: NotificationRequest[] = []
  hub.on('notification', (notification) => notifications.push(notification))

  const completeTurn = (turnId: string, timestamp: number): void => {
    hub.ingest({
      id: `${turnId}-prompt`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: 'locale-session',
      externalTurnId: turnId,
      cwd: 'E:/project/locale-demo',
      message: 'Please fix the update timeout',
      timestamp,
    })
    hub.ingest({
      id: `${turnId}-stop`,
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: 'locale-session',
      externalTurnId: turnId,
      cwd: 'E:/project/locale-demo',
      timestamp: timestamp + 1,
    })
  }

  completeTurn('turn-en', 2_000_000)
  assert.match(notifications[0]?.title ?? '', /completed/)
  assert.equal(notifications[0]?.body, 'fix the update timeout')

  hub.setLocale('zh')
  completeTurn('turn-zh', 2_000_010)
  assert.match(notifications[1]?.title ?? '', /已完成/)
  assert.equal(notifications[1]?.body, '任务已完成，请打开应用查看详情')
  assert.doesNotMatch(notifications[1]?.body ?? '', /\b(fix|update|timeout|completed)\b/i)
})

test('StatusHub keeps concurrent sessions in the same workspace separate', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'session-a-prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: 100,
  })
  hub.ingest({
    id: 'session-b-prompt',
    source: 'claude_code',
    eventType: 'prompt_submit',
    externalSessionId: 'session-b',
    cwd: 'E:/project/a',
    timestamp: 200,
  })
  hub.ingest({
    id: 'session-a-tool',
    source: 'claude_code',
    eventType: 'tool_start',
    externalSessionId: 'session-a',
    toolName: 'Bash',
    timestamp: 300,
  })
  hub.ingest({
    id: 'session-b-stop',
    source: 'claude_code',
    eventType: 'turn_stop',
    externalSessionId: 'session-b',
    timestamp: 400,
  })

  const claudeAgents = hub.snapshot().agents.filter((agent) => agent.agentType === 'claude_code')
  assert.equal(claudeAgents.length, 2)
  assert.equal(claudeAgents[0]?.externalSessionId, 'session-b')
  assert.deepEqual(
    claudeAgents.map((agent) => `${agent.externalSessionId}:${agent.state}`).sort(),
    ['session-a:TOOL_RUNNING', 'session-b:DONE'],
  )
  assert.deepEqual(claudeAgents.map((agent) => agent.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/a',
  ])
})

test('StatusHub can acknowledge one workspace without clearing another', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  for (const project of ['a', 'b']) {
    hub.ingest({
      id: `${project}-prompt`,
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: `session-${project}`,
      cwd: `E:/project/${project}`,
      timestamp: 100,
    })
    hub.ingest({
      id: `${project}-stop`,
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: `session-${project}`,
      cwd: `E:/project/${project}`,
      message: 'done',
      timestamp: 200,
    })
  }

  hub.acknowledge('codex', 'E:/project/a')

  const byWorkspace = new Map(
    hub.snapshot().agents.map((agent) => [agent.workspacePath, agent.unread]),
  )
  assert.equal(byWorkspace.get('E:/project/a'), false)
  assert.equal(byWorkspace.get('E:/project/b'), true)
})

test('StatusHub keeps Claude and Codex token snapshots separate in the same workspace', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'claude-token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      total: 10_000,
      contextUsedPercent: 40,
      rateLimits: { fiveHour: { usedPercent: 24 } },
      accuracy: 'exact',
    },
  })
  hub.ingest({
    id: 'codex-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: {
      total: 20_000,
      contextUsedPercent: 12,
      rateLimits: { fiveHour: { usedPercent: 61 } },
      accuracy: 'estimated',
    },
  })

  const agents = hub.snapshot().agents
  const claude = agents.find((agent) => agent.agentType === 'claude_code')
  const codex = agents.find((agent) => agent.agentType === 'codex')

  assert.equal(agents.length, 2)
  assert.equal(claude?.workspacePath, 'E:/project/a')
  assert.equal(codex?.workspacePath, 'E:/project/a')
  assert.equal(claude?.token?.contextUsedPercent, 40)
  assert.equal(claude?.token?.rateLimits?.fiveHour?.usedPercent, 24)
  assert.equal(codex?.token?.contextUsedPercent, 12)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 61)
})

test('StatusHub merges partial token snapshots instead of dropping previous fields', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'full-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      total: 10_000,
      contextUsedPercent: 24,
      contextWindow: 256_000,
      rateLimits: {
        fiveHour: { usedPercent: 61, resetsAt: 2_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 18, resetsAt: 9_000 },
      },
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'partial-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: {
      total: 12_000,
      contextUsedPercent: 26,
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.total, 12_000)
  assert.equal(codex?.token?.contextUsedPercent, 26)
  assert.equal(codex?.token?.contextWindow, 256_000)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 61)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 2_000)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 18)
})

test('StatusHub marks contextCompressed when occupancy drops sharply on same window', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'ctx-high',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/compact',
    timestamp: 100,
    token: {
      contextUsedPercent: 72,
      contextWindow: 256_000,
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'ctx-after-compact',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/compact',
    timestamp: 200,
    token: {
      contextUsedPercent: 28,
      contextWindow: 256_000,
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.contextUsedPercent, 28)
  assert.equal(codex?.token?.contextCompressed, true)

  hub.ingest({
    id: 'ctx-grow-again',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/compact',
    timestamp: 300,
    token: {
      contextUsedPercent: 40,
      contextWindow: 256_000,
      accuracy: 'estimated',
    },
  })
  const afterGrow = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(afterGrow?.token?.contextCompressed, false)
})

test('StatusHub ignores small context decreases while keeping coupled token fields atomic', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'context-high',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'context-session',
    cwd: 'E:/project/context-stable',
    timestamp: 100,
    token: {
      input: 102_000,
      total: 104_000,
      contextUsedPercent: 40,
      contextWindow: 256_000,
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'context-small-drop',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'context-session',
    cwd: 'E:/project/context-stable',
    timestamp: 200,
    token: {
      input: 98_000,
      total: 100_000,
      contextUsedPercent: 38,
      contextWindow: 256_000,
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.contextUsedPercent, 40)
  assert.equal(codex?.token?.input, 102_000)
  assert.equal(codex?.token?.total, 104_000)
  assert.equal(codex?.token?.contextCompressed, undefined)
})

test('StatusHub rejects switching weekly quota to a different bucket family on partial updates', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const future = Math.floor(Date.now() / 1000) + 86_400

  hub.ingest({
    id: 'main-weekly',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/quota-stick',
    model: 'gpt-5.3-codex',
    timestamp: 100,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent: 41, resetsAt: future, windowMinutes: 10_080 },
      },
    },
  })
  hub.ingest({
    id: 'spark-noise',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/quota-stick',
    model: 'gpt-5.3-codex',
    timestamp: 200,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        sevenDay: { usedPercent: 2, resetsAt: future, windowMinutes: 10_080 },
      },
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.rateLimitId, 'codex')
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 41)
})

test('StatusHub keeps exact context data when later estimated token snapshots arrive', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'official-token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      input: 210_000,
      total: 212_000,
      contextUsedPercent: 21,
      contextWindow: 1_000_000,
      accuracy: 'exact',
    },
  })
  hub.ingest({
    id: 'transcript-token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: {
      input: 50_000,
      total: 51_000,
      contextUsedPercent: 25,
      contextWindow: 200_000,
      accuracy: 'estimated',
    },
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  // Exact context (and matching usage totals) must not be clobbered by estimated patches.
  assert.equal(claude?.token?.input, 210_000)
  assert.equal(claude?.token?.total, 212_000)
  assert.equal(claude?.token?.contextUsedPercent, 21)
  assert.equal(claude?.token?.contextWindow, 1_000_000)
  assert.equal(claude?.token?.accuracy, 'exact')
})

test('StatusHub preserves quota windows when a zero-only token snapshot arrives', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'quota-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      contextUsedPercent: 24,
      rateLimits: {
        fiveHour: { usedPercent: 33, resetsAt: 2_000 },
        sevenDay: { usedPercent: 7, resetsAt: 9_000 },
      },
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'empty-quota-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: {
      contextUsedPercent: 26,
      rateLimits: {
        fiveHour: { usedPercent: 0 },
        sevenDay: { usedPercent: 0 },
      },
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.contextUsedPercent, 26)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 33)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 2_000)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 7)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, 9_000)
})

test('StatusHub accepts lower quota only after five confirmed observations', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'quota-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      contextUsedPercent: 24,
      rateLimits: {
        fiveHour: { usedPercent: 33, resetsAt: 2_000 },
        sevenDay: { usedPercent: 7, resetsAt: 9_000 },
      },
      accuracy: 'estimated',
    },
  })
  for (let read = 1; read <= 5; read += 1) {
    hub.ingest({
      id: `zero-quota-token-${read}`,
      source: 'codex',
      eventType: 'token_snapshot',
      cwd: 'E:/project/a',
      timestamp: 200 + read,
      token: {
        contextUsedPercent: 26,
        rateLimits: {
          fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 0, resetsAt: 10_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
      internal: { usageSampleId: `official-reset-${read}` },
    })

    if (read < 5) {
      const pending = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
      assert.equal(pending?.token?.rateLimits?.fiveHour?.usedPercent, 33)
      assert.equal(pending?.token?.rateLimits?.sevenDay?.usedPercent, 7)
    }
  }

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.contextUsedPercent, 26)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 3_000)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 0)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, 10_000)
})

test('StatusHub deduplicates fan-out reads and projects confirmed resets to every session', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const highReset = Math.floor(Date.now() / 1000) + 86_400
  const lowReset = highReset + 7 * 86_400

  hub.ingest({
    id: 'initial-high',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: {
      accuracy: 'estimated',
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 40, resetsAt: highReset, windowMinutes: 10_080 },
      },
    },
  })

  for (let project = 0; project < 5; project += 1) {
    hub.ingest({
      id: `fan-out-${project}`,
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: `session-${project + 2}`,
      cwd: `E:/project/${project + 2}`,
      timestamp: 200 + project,
      token: {
        accuracy: 'estimated',
        rateLimitId: 'codex',
        rateLimits: {
          sevenDay: { usedPercent: 3, resetsAt: lowReset, windowMinutes: 10_080 },
        },
      },
      internal: { usageSampleId: 'one-account-read' },
    })
  }
  assert.ok(
    hub.snapshot().agents.every((agent) => agent.token?.rateLimits?.sevenDay?.usedPercent === 40),
  )

  for (let read = 2; read <= 5; read += 1) {
    hub.ingest({
      id: `confirmed-low-${read}`,
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      timestamp: 300 + read,
      token: {
        accuracy: 'estimated',
        rateLimitId: 'codex',
        rateLimits: {
          sevenDay: { usedPercent: 3, resetsAt: lowReset, windowMinutes: 10_080 },
        },
      },
      internal: { usageSampleId: `account-read-${read}` },
    })
  }

  const agents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
  assert.ok(agents.length > 1)
  assert.ok(agents.every((agent) => agent.token?.rateLimits?.sevenDay?.usedPercent === 3))
  assert.ok(agents.every((agent) => agent.token?.rateLimits?.sevenDay?.resetsAt === lowReset))
})

test('StatusHub emits an account observation only when its accepted quota changes', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const firstReset = Math.floor(Date.now() / 1000) + 86_400
  const nextReset = firstReset + 7 * 86_400
  hub.ingest({
    id: 'quota-seed',
    source: 'kimi',
    eventType: 'token_snapshot',
    externalSessionId: 'kimi-session',
    cwd: 'E:/project/kimi',
    timestamp: 100,
    token: {
      accuracy: 'exact',
      rateLimits: {
        sevenDay: { usedPercent: 80, resetsAt: firstReset, windowMinutes: 10_080 },
      },
    },
  })

  let emittedStatuses = 0
  hub.on('status', () => {
    emittedStatuses += 1
  })
  for (let read = 1; read <= 5; read += 1) {
    const changed = hub.observeQuota({
      id: `quota-observation-${read}`,
      source: 'kimi',
      eventType: 'token_snapshot',
      externalSessionId: 'kimi-session',
      cwd: 'E:/project/kimi',
      timestamp: 200 + read,
      token: {
        accuracy: 'exact',
        rateLimits: {
          sevenDay: { usedPercent: 4, resetsAt: nextReset, windowMinutes: 10_080 },
        },
      },
      internal: {
        quotaRefresh: true,
        usageSampleId: `quota-observation-${read}`,
      },
    })
    assert.equal(changed, read === 5)
  }

  const kimi = hub.snapshot().agents.find((agent) => agent.agentType === 'kimi')
  assert.equal(kimi?.token?.rateLimits?.sevenDay?.usedPercent, 4)
  assert.equal(emittedStatuses, 1)
})

test('StatusHub restarts lower-quota confirmation after an equal reading', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const resetAt = Math.floor(Date.now() / 1000) + 86_400

  const ingestUsage = (id: string, usedPercent: number): void => {
    hub.ingest({
      id,
      source: 'claude_code',
      eventType: 'token_snapshot',
      externalSessionId: 'claude-session',
      cwd: 'E:/project/claude',
      timestamp: 100,
      token: {
        accuracy: 'exact',
        rateLimits: {
          sevenDay: { usedPercent, resetsAt: resetAt, windowMinutes: 10_080 },
        },
      },
      internal: { usageSampleId: id },
    })
  }

  ingestUsage('seed-50', 50)
  for (let read = 1; read <= 4; read += 1) ingestUsage(`first-low-${read}`, 5)
  ingestUsage('equal-breaks-streak', 50)
  for (let read = 1; read <= 4; read += 1) ingestUsage(`second-low-${read}`, 6)

  let claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.token?.rateLimits?.sevenDay?.usedPercent, 50)
  ingestUsage('second-low-5', 6)
  claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.token?.rateLimits?.sevenDay?.usedPercent, 6)
})

test('StatusHub keeps Codex quota buckets separated by limit id', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'default-quota',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'gpt-5.5',
    timestamp: 100,
    token: {
      rateLimitId: 'codex',
      rateLimits: {
        fiveHour: { usedPercent: 78, resetsAt: 2_000 },
        sevenDay: { usedPercent: 11, resetsAt: 9_000 },
      },
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'spark-quota',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'gpt-5.3-spark',
    timestamp: 200,
    token: {
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        fiveHour: { usedPercent: 2, resetsAt: 3_000 },
        sevenDay: { usedPercent: 1, resetsAt: 10_000 },
      },
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 2)
  assert.equal(codex?.token?.quotaBuckets?.codex?.rateLimits?.fiveHour?.usedPercent, 78)
  assert.equal(codex?.token?.quotaBuckets?.codex_bengalfox?.rateLimits?.fiveHour?.usedPercent, 2)
})

test('StatusHub does not refresh a quota bucket timestamp from an older window', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const capturedAt = Date.now()
  const nowSeconds = Math.floor(capturedAt / 1000)

  hub.ingest({
    id: 'new-quota-window',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'gpt-5.5',
    timestamp: capturedAt,
    token: {
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: {
          usedPercent: 5,
          resetsAt: nowSeconds + 6 * 86_400,
          windowMinutes: 10_080,
        },
      },
      accuracy: 'estimated',
    },
  })
  hub.ingest({
    id: 'stale-quota-window',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'session-a',
    cwd: 'E:/project/a',
    model: 'gpt-5.5',
    timestamp: capturedAt + 1_000,
    token: {
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: {
          usedPercent: 82,
          resetsAt: nowSeconds + 86_400,
          windowMinutes: 10_080,
        },
      },
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  const bucket = codex?.token?.quotaBuckets?.codex
  assert.equal(bucket?.rateLimits?.sevenDay?.usedPercent, 5)
  assert.equal(bucket?.rateLimits?.sevenDay?.resetsAt, nowSeconds + 6 * 86_400)
  assert.equal(bucket?.updatedAt, capturedAt)
})

test('StatusHub treats small quota reset drift as the same weekly window', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const futureSeconds = Math.floor(Date.now() / 1000) + 6 * 86_400
  // One second below a five-minute rounding boundary reproduces the old false period split.
  const resetAt = Math.floor(futureSeconds / 300) * 300 + 149

  for (const [id, usedPercent, driftSeconds, timestamp] of [
    ['high-usage', 35, 0, 100],
    ['clock-drift-higher', 36, -30, 200],
    ['clock-drift-low', 2, 2, 300],
  ] as const) {
    hub.ingest({
      id,
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-reset-drift',
      cwd: 'E:/project/reset-drift',
      timestamp,
      token: {
        rateLimitId: 'codex',
        rateLimits: {
          sevenDay: {
            usedPercent,
            resetsAt: resetAt + driftSeconds,
            windowMinutes: 10_080,
          },
        },
        accuracy: 'estimated',
      },
    })
  }

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 36)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, resetAt)
})

test('StatusHub keeps previous token data at session boundaries until a new snapshot arrives', () => {
  const hub = new StatusHub({ sessionThrottleMs: 0 })

  hub.ingest({
    id: 'token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 100,
    token: { contextUsedPercent: 88, accuracy: 'exact' },
  })
  hub.ingest({
    id: 'session-start',
    source: 'claude_code',
    eventType: 'session_start',
    cwd: 'E:/project/a',
    timestamp: 200,
  })

  const claude = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(claude?.token?.contextUsedPercent, 88)

  hub.ingest({
    id: 'new-token',
    source: 'claude_code',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 300,
    token: { contextUsedPercent: 12, accuracy: 'exact' },
  })

  const updated = hub.snapshot().agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(updated?.token?.contextUsedPercent, 12)
})

test('display agents are grouped by workspace with a shared token', () => {
  const groups = buildWorkspaceAgentGroups([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
      token: { total: 1200, contextUsedPercent: 12, accuracy: 'estimated' },
    },
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: true,
      workspacePath: 'E:/project/b',
      token: { total: 800, contextUsedPercent: 8, accuracy: 'exact' },
    },
  ])

  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((group) => group.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/b',
  ])
  assert.deepEqual(
    groups
      .flatMap((group) => group.agents.map((agent) => `${group.workspacePath}:${agent.agentType}`))
      .sort(),
    [
      'E:/project/a:claude_code',
      'E:/project/a:codex',
      'E:/project/a:grok',
      'E:/project/a:kimi',
      'E:/project/b:claude_code',
      'E:/project/b:codex',
      'E:/project/b:grok',
      'E:/project/b:kimi',
    ],
  )
  assert.equal(groups.find((group) => group.workspacePath === 'E:/project/a')?.token?.total, 1200)
})

test('display panels group slash and backslash variants into one project', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.PROMPT_SUBMITTED,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'running',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:\\project\\a',
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 200,
      unread: false,
      workspacePath: 'E:/project/a',
      token: { contextUsedPercent: 12, accuracy: 'estimated' },
    },
  ])

  const codexPanel = panels.find((panel) => panel.agentType === 'codex')
  assert.equal(codexPanel?.workspaces.length, 1)
  assert.equal(codexPanel?.workspaces[0]?.agent.token?.contextUsedPercent, 12)
})

test('display panels omit agent shells when there are no projects', () => {
  const panels = buildAgentPanels([])
  assert.equal(panels.length, 0)
})

test('display panels only include agents that have active projects', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
    },
    {
      agentType: 'grok',
      state: TurnState.THINKING,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
    },
  ])

  assert.deepEqual(
    panels.map((panel) => panel.agentType),
    ['codex', 'grok'],
  )
  assert.equal(
    panels.find((panel) => panel.agentType === 'claude_code'),
    undefined,
  )
})

test('display panels keep quota-only agent after projects are hidden', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 200,
      unread: false,
      taskHidden: true,
      workspacePath: 'E:/project/a',
      token: {
        accuracy: 'exact',
        rateLimits: {
          fiveHour: { usedPercent: 40, resetsAt: 1_000 },
          sevenDay: { usedPercent: 12 },
        },
      },
    },
  ])

  assert.equal(panels.length, 1)
  assert.equal(panels[0]?.agentType, 'codex')
  assert.equal(panels[0]?.workspaces.length, 0)
  assert.equal(panels[0]?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 40)
})

test('display panels do not show pathless agents as unknown project cards', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 300,
      unread: false,
      // No workspacePath — quota shell / probe event.
      token: {
        accuracy: 'estimated',
        rateLimits: {
          fiveHour: { usedPercent: 5, resetsAt: 2_000 },
          sevenDay: { usedPercent: 20, resetsAt: 9_000 },
        },
      },
    },
    {
      agentType: 'codex',
      state: TurnState.IDLE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: 400,
      unread: false,
      token: {
        accuracy: 'estimated',
        rateLimits: {
          sevenDay: { usedPercent: 12, resetsAt: 9_000 },
        },
      },
    },
  ])

  const claude = panels.find((panel) => panel.agentType === 'claude_code')
  const codex = panels.find((panel) => panel.agentType === 'codex')
  assert.ok(claude, 'Claude pane kept for quota')
  assert.ok(codex, 'Codex pane kept for quota')
  assert.equal(claude?.workspaces.length, 0)
  assert.equal(codex?.workspaces.length, 0)
  assert.equal(claude?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 5)
  assert.equal(codex?.quotaToken?.rateLimits?.sevenDay?.usedPercent, 12)
})

test('display panels keep Codex projects inside one panel', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: true,
      workspacePath: 'E:/project/a',
      token: { total: 1200, contextUsedPercent: 12, accuracy: 'estimated' },
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        total: 800,
        contextUsedPercent: 8,
        rateLimits: { fiveHour: { usedPercent: 42 } },
        accuracy: 'estimated',
      },
    },
  ])

  const codexPanel = panels.find((panel) => panel.agentType === 'codex')
  assert.equal(codexPanel?.workspaces.length, 2)
  assert.deepEqual(codexPanel?.workspaces.map((item) => item.workspacePath).sort(), [
    'E:/project/a',
    'E:/project/b',
  ])
})

test('display panels keep Claude and Codex five-hour quotas separate', () => {
  const panels = buildAgentPanels([
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 500,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 40,
        rateLimits: {
          fiveHour: { usedPercent: 24, resetsAt: 1_000 },
          sevenDay: { usedPercent: 11 },
        },
        accuracy: 'exact',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.THINKING,
      toolCallCount: 1,
      needPermission: false,
      needUserInput: false,
      activity: 'thinking',
      lastEventAt: 600,
      unread: true,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 61, resetsAt: 2_000 },
          sevenDay: { usedPercent: 18 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  const claudePanel = panels.find((panel) => panel.agentType === 'claude_code')
  const codexPanel = panels.find((panel) => panel.agentType === 'codex')

  assert.equal(claudePanel?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 24)
  assert.equal(claudePanel?.quotaToken?.rateLimits?.fiveHour?.resetsAt, 1_000)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.fiveHour?.usedPercent, 61)
  assert.equal(codexPanel?.quotaToken?.rateLimits?.fiveHour?.resetsAt, 2_000)
})

test('latest quota token uses the newest rate-limit payload', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 12,
        rateLimits: { fiveHour: { usedPercent: 12 } },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'claude_code',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 8,
        rateLimits: { fiveHour: { usedPercent: 36 } },
        accuracy: 'exact',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 36)
})

test('latest quota token prefers the active model quota when model sessions overlap', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          contextUsedPercent: 12,
          rateLimits: { fiveHour: { usedPercent: 82 }, sevenDay: { usedPercent: 12 } },
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-spark',
        token: {
          contextUsedPercent: 8,
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 82)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 12)
})

test('collectQuotaMeters prefers higher same-window weekly % over active stale session', () => {
  const future = Math.floor(Date.now() / 1000) + 86_400
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 900,
        unread: false,
        workspacePath: 'E:/work/active-stale',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 2, resetsAt: future, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/idle-correct',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 35, resetsAt: future, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})

test('collectQuotaMeters prefers a newer weekly period over an older high percentage', () => {
  const nowSeconds = Math.floor(Date.now() / 1000)
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/old-period',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: {
              usedPercent: 82,
              resetsAt: nowSeconds + 86_400,
              windowMinutes: 10_080,
            },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/new-period',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: {
              usedPercent: 5,
              resetsAt: nowSeconds + 6 * 86_400,
              windowMinutes: 10_080,
            },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 5)
})

test('collectQuotaMeters absorbs minor reset drift within one weekly period', () => {
  const futureSeconds = Math.floor(Date.now() / 1000) + 6 * 86_400
  // Straddle the old Math.round(... / 5 minutes) boundary by only two seconds.
  const resetAt = Math.floor(futureSeconds / 300) * 300 + 149
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/reset-drift-high',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 35, resetsAt: resetAt, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/reset-drift-low',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 2, resetsAt: resetAt + 2, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})

test('collectQuotaMeters keeps a soft-reset zero over an expired same-period high', () => {
  const expiredReset = Math.floor(Date.now() / 1000) - 60
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/pre-reset-stale',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 82, resetsAt: expiredReset, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/post-reset-zero',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            sevenDay: { usedPercent: 0, resetsAt: expiredReset, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 0)
})

test('collectQuotaMeters ignores hidden five-hour resets when choosing Codex weekly usage', () => {
  const weeklyReset = Math.floor(Date.now() / 1000) + 30 * 60
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/work/five-hour-noise',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            fiveHour: { usedPercent: 1, resetsAt: weeklyReset + 4 * 3_600 },
            sevenDay: { usedPercent: 2, resetsAt: weeklyReset, windowMinutes: 10_080 },
          },
        },
      },
      {
        agentType: 'codex',
        state: TurnState.IDLE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/work/weekly-authoritative',
        model: 'gpt-5.3-codex',
        token: {
          accuracy: 'estimated',
          rateLimitId: 'codex',
          rateLimits: {
            fiveHour: { usedPercent: 1, resetsAt: weeklyReset + 60 * 60 },
            sevenDay: { usedPercent: 35, resetsAt: weeklyReset, windowMinutes: 10_080 },
          },
        },
      },
    ],
    'codex',
  )

  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 35)
})

test('latest quota token selects the matching bucket when one token carries multiple Codex buckets', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { fiveHour: { usedPercent: 78 }, sevenDay: { usedPercent: 16 } },
              updatedAt: 100,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
              updatedAt: 300,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  assert.equal(quota?.rateLimitId, 'codex')
  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 78)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 16)
})

test('latest quota token ignores Spark-only payload while the active model is non-Spark', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.5',
  )

  // No compatible non-Spark quota → nothing to show for this session model.
  assert.equal(quota, undefined)
})

test('latest quota token accepts Spark quota when the active Codex model is Spark', () => {
  const quota = latestQuotaToken(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { fiveHour: { usedPercent: 2 }, sevenDay: { usedPercent: 1 } },
          accuracy: 'estimated',
        },
      },
    ],
    'gpt-5.3-spark',
  )

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 2)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 1)
})

test('collectQuotaMeters stacks default weekly and Spark only when both models are active', () => {
  const dualBuckets = {
    codex: {
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent: 38, resetsAt: 1_000, windowMinutes: 10_080 },
      },
      updatedAt: 200,
    },
    codex_bengalfox: {
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        sevenDay: { usedPercent: 0, resetsAt: 2_000, windowMinutes: 10_080 },
      },
      updatedAt: 300,
    },
  }
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.5',
        token: {
          rateLimitId: 'codex',
          rateLimitName: 'Codex',
          rateLimits: { sevenDay: { usedPercent: 38, resetsAt: 1_000, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/b',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, resetsAt: 2_000, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 2)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 38)
  assert.equal(meters[1]?.id, 'codex_bengalfox')
  assert.equal(meters[1]?.token.rateLimitName, 'GPT-5.3-Codex-Spark')
})

test('collectQuotaMeters hides Spark while an active non-Spark model is running (gpt-5.6-sol)', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 500,
        unread: false,
        workspacePath: 'E:/project/metalmax',
        model: 'gpt-5.6-sol',
        token: {
          // Sticky Spark-only buckets must not become a second 每周额度 bar.
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, resetsAt: 9_000, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimitName: 'Codex',
              rateLimits: {
                sevenDay: { usedPercent: 43, resetsAt: 8_000, windowMinutes: 10_080 },
              },
              updatedAt: 400,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: {
                sevenDay: { usedPercent: 0, resetsAt: 9_000, windowMinutes: 10_080 },
              },
              updatedAt: 500,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 43)
  assert.doesNotMatch(
    `${meters[0]?.token.rateLimitId ?? ''} ${meters[0]?.token.rateLimitName ?? ''}`,
    /spark|bengalfox/i,
  )
})

test('collectQuotaMeters does not show twin weekly bars from Spark + default for non-Spark models', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/project/spark-old',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
              updatedAt: 50,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
          },
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.TOOL_RUNNING,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 200,
        unread: false,
        workspacePath: 'E:/project/weekly-now',
        model: 'gpt-5.6-sol',
        token: {
          rateLimitId: 'codex',
          rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 43, windowMinutes: 10_080 } },
              updatedAt: 200,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 0, windowMinutes: 10_080 } },
              updatedAt: 150,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 43)
})

test('collectQuotaMeters follows the latest model and hides stale Spark after switching to weekly models', () => {
  const dualBuckets = {
    codex: {
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent: 42, resetsAt: 1_000, windowMinutes: 10_080 },
      },
      // Spark bucket was refreshed more recently by a previous turn — must not win.
      updatedAt: 100,
    },
    codex_bengalfox: {
      rateLimitId: 'codex_bengalfox',
      rateLimitName: 'GPT-5.3-Codex-Spark',
      rateLimits: {
        sevenDay: { usedPercent: 3, resetsAt: 2_000, windowMinutes: 10_080 },
      },
      updatedAt: 999,
    },
  }
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 100,
        unread: false,
        workspacePath: 'E:/project/old-spark',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 3, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
      {
        agentType: 'codex',
        state: TurnState.DONE,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'done',
        lastEventAt: 500,
        unread: false,
        workspacePath: 'E:/project/latest-weekly',
        model: 'gpt-5.6',
        token: {
          rateLimitId: 'codex',
          rateLimitName: 'Codex',
          rateLimits: { sevenDay: { usedPercent: 42, windowMinutes: 10_080 } },
          quotaBuckets: dualBuckets,
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 42)
  assert.doesNotMatch(meters[0]?.token.rateLimitName ?? '', /Spark/i)
})

test('collectQuotaMeters shows only Spark weekly when only Spark was used', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-codex-spark',
        token: {
          rateLimitId: 'codex_bengalfox',
          rateLimitName: 'GPT-5.3-Codex-Spark',
          rateLimits: { sevenDay: { usedPercent: 5, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 40, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 5, windowMinutes: 10_080 } },
              updatedAt: 300,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex_bengalfox')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 5)
})

test('collectQuotaMeters shows only default weekly for non-Spark gpt-5.3 models', () => {
  const meters = collectQuotaMeters(
    [
      {
        agentType: 'codex',
        state: TurnState.PROMPT_SUBMITTED,
        toolCallCount: 0,
        needPermission: false,
        needUserInput: false,
        activity: 'running',
        lastEventAt: 300,
        unread: false,
        workspacePath: 'E:/project/a',
        model: 'gpt-5.3-codex',
        token: {
          rateLimitId: 'codex',
          rateLimits: { sevenDay: { usedPercent: 22, windowMinutes: 10_080 } },
          quotaBuckets: {
            codex: {
              rateLimitId: 'codex',
              rateLimits: { sevenDay: { usedPercent: 22, windowMinutes: 10_080 } },
              updatedAt: 300,
            },
            codex_bengalfox: {
              rateLimitId: 'codex_bengalfox',
              rateLimitName: 'GPT-5.3-Codex-Spark',
              rateLimits: { sevenDay: { usedPercent: 1, windowMinutes: 10_080 } },
              updatedAt: 100,
            },
          },
          accuracy: 'estimated',
        },
      },
    ],
    'codex',
  )

  assert.equal(meters.length, 1)
  assert.equal(meters[0]?.id, 'codex')
  assert.equal(meters[0]?.token.rateLimits?.sevenDay?.usedPercent, 22)
})

test('latest quota token prefers the freshest recent payload', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/high',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 78, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 28, resetsAt: 2_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 200,
      unread: false,
      workspacePath: 'E:/project/zero',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 0, resetsAt: 4_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 0)
})

test('latest quota token accepts fresh zero quota with reset metadata', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/stale',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 78, resetsAt: 1_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 28, resetsAt: 2_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100 + 31 * 60_000,
      unread: false,
      workspacePath: 'E:/project/fresh',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 0, resetsAt: 4_000, windowMinutes: 10_080 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 0)
})

test('latest quota token skips empty zero-only rate-limit payloads', () => {
  const quota = latestQuotaToken([
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 100,
      unread: false,
      workspacePath: 'E:/project/a',
      token: {
        contextUsedPercent: 12,
        rateLimits: {
          fiveHour: { usedPercent: 33, resetsAt: 1_000 },
          sevenDay: { usedPercent: 7, resetsAt: 2_000 },
        },
        accuracy: 'estimated',
      },
    },
    {
      agentType: 'codex',
      state: TurnState.DONE,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      activity: 'done',
      lastEventAt: 300,
      unread: false,
      workspacePath: 'E:/project/b',
      token: {
        contextUsedPercent: 8,
        rateLimits: {
          fiveHour: { usedPercent: 0 },
          sevenDay: { usedPercent: 0 },
        },
        accuracy: 'estimated',
      },
    },
  ])

  assert.equal(quota?.rateLimits?.fiveHour?.usedPercent, 33)
  assert.equal(quota?.rateLimits?.sevenDay?.usedPercent, 7)
})

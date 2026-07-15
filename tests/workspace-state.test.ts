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

test('StatusHub clears turn start time when watchdog marks TIMEOUT', () => {
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

test('StatusHub only emits notifications for completed turns', () => {
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
  ;(hub as unknown as { tick(now?: number): void }).tick(startedAt + STUCK_VISIBLE_MS + 3)

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
  assert.equal(claude?.token?.input, 50_000)
  assert.equal(claude?.token?.total, 51_000)
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

test('StatusHub accepts zero quota windows when reset metadata is present', () => {
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
    id: 'zero-quota-token',
    source: 'codex',
    eventType: 'token_snapshot',
    cwd: 'E:/project/a',
    timestamp: 200,
    token: {
      contextUsedPercent: 26,
      rateLimits: {
        fiveHour: { usedPercent: 0, resetsAt: 3_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 0, resetsAt: 10_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    },
  })

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.token?.contextUsedPercent, 26)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 0)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.resetsAt, 3_000)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 0)
  assert.equal(codex?.token?.rateLimits?.sevenDay?.resetsAt, 10_000)
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
      'E:/project/b:claude_code',
      'E:/project/b:codex',
      'E:/project/b:grok',
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

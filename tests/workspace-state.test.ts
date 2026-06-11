import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { TurnState } from '@codepulse/shared'
import {
  buildAgentPanels,
  buildWorkspaceAgentGroups,
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
      'E:/project/b:claude_code',
      'E:/project/b:codex',
    ],
  )
  assert.equal(groups.find((group) => group.workspacePath === 'E:/project/a')?.token?.total, 1200)
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

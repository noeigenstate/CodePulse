import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import {
  buildProjectDeckItems,
  buildProjectUsageSummaries,
} from '../apps/desktop/src/renderer/src/lib/projectDeck.js'
import type {
  AgentPanel,
  AgentWorkspaceItem,
} from '../apps/desktop/src/renderer/src/lib/displayAgents.js'

function runtime(
  agentType: AgentRuntimeState['agentType'],
  state: TurnState,
  workspacePath: string,
  lastEventAt: number,
  unread = false,
): AgentRuntimeState {
  return {
    agentType,
    state,
    workspacePath,
    toolCallCount: 0,
    needPermission: state === TurnState.WAITING_PERMISSION,
    needUserInput: state === TurnState.WAITING_USER_INPUT,
    lastEventAt,
    unread,
  }
}

function panel(
  agentType: AgentPanel['agentType'],
  workspaces: AgentWorkspaceItem[],
  usedPercent?: number,
): AgentPanel {
  return {
    agentType,
    name: agentType,
    updatedAt: Math.max(0, ...workspaces.map((item) => item.updatedAt)),
    quotaMeters:
      usedPercent == null
        ? []
        : [
            {
              id: 'default',
              updatedAt: 1,
              token: {
                accuracy: 'exact',
                rateLimits: { sevenDay: { usedPercent, resetsAt: 2_000_000_000 } },
              },
            },
          ],
    workspaces,
  }
}

test('project deck merges the same workspace across providers and keeps provider metadata', () => {
  const path = 'F:/future/codepulse/CodePulse'
  const codex = runtime('codex', TurnState.TOOL_RUNNING, path, 20)
  const claude = runtime('claude_code', TurnState.DONE, path, 30, true)

  const items = buildProjectDeckItems([
    panel('codex', [
      { id: 'codex:cp', name: 'CodePulse', workspacePath: path, updatedAt: 20, agent: codex },
    ]),
    panel('claude_code', [
      { id: 'claude:cp', name: 'CodePulse', workspacePath: path, updatedAt: 30, agent: claude },
    ]),
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0]?.name, 'CodePulse')
  assert.deepEqual(items[0]?.sources.map((source) => source.agentType).sort(), [
    'claude_code',
    'codex',
  ])
  assert.equal(items[0]?.primary.agent, claude)
})

test('project deck sorts intervention and unread outcomes ahead of active and quiet work', () => {
  const waiting = runtime('codex', TurnState.WAITING_PERMISSION, 'F:/waiting', 10)
  const done = runtime('claude_code', TurnState.DONE, 'F:/done', 40, true)
  const active = runtime('codex', TurnState.THINKING, 'F:/active', 50)
  const quiet = runtime('grok', TurnState.IDLE, 'F:/quiet', 60)
  const agents = [waiting, done, active, quiet]
  const items = buildProjectDeckItems(
    agents.map((agent) =>
      panel(agent.agentType, [
        {
          id: `${agent.agentType}:${agent.workspacePath}`,
          name: agent.workspacePath?.split('/').at(-1) ?? '',
          workspacePath: agent.workspacePath,
          updatedAt: agent.lastEventAt,
          agent,
        },
      ]),
    ),
  )

  assert.deepEqual(
    items.map((item) => item.name),
    ['waiting', 'done', 'active', 'quiet'],
  )
})

test('quota-only providers stay out of the project grid but remain in the usage strip', () => {
  const grok = panel('grok', [], 18)

  assert.deepEqual(buildProjectDeckItems([grok]), [])
  assert.deepEqual(buildProjectUsageSummaries([grok]), [
    { agentType: 'grok', label: 'GROK', percent: 18 },
  ])
})

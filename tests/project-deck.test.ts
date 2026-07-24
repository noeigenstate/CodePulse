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

test('project deck orders cards by provider rank regardless of attention state', () => {
  const grokAlarm = runtime('grok', TurnState.WAITING_PERMISSION, 'F:/grok-alarm', 10)
  const claudeQuiet = runtime('claude_code', TurnState.IDLE, 'F:/claude-quiet', 20)
  const codexDone = runtime('codex', TurnState.DONE, 'F:/codex-done', 30, true)
  const kimiActive = runtime('kimi', TurnState.THINKING, 'F:/kimi-active', 40)
  const agents = [grokAlarm, claudeQuiet, codexDone, kimiActive]
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

  // Implicit provider order is absolute: claude → codex → kimi → grok, even
  // when another provider's card is the one demanding attention.
  assert.deepEqual(
    items.map((item) => item.name),
    ['claude-quiet', 'codex-done', 'kimi-active', 'grok-alarm'],
  )
})

test('project deck keeps first-seen order between cards of the same provider', () => {
  const older = runtime('codex', TurnState.IDLE, 'F:/older', 10)
  const newer = runtime('codex', TurnState.DONE, 'F:/newer', 50, true)
  const items = buildProjectDeckItems([
    panel('codex', [
      { id: 'codex:older', name: 'older', workspacePath: 'F:/older', updatedAt: 10, agent: older },
      { id: 'codex:newer', name: 'newer', workspacePath: 'F:/newer', updatedAt: 50, agent: newer },
    ]),
  ])

  // 先到先得:卡片位置不随状态或最近更新时间挪动。
  assert.deepEqual(
    items.map((item) => item.name),
    ['older', 'newer'],
  )
})

test('quota-only providers stay out of the project grid but remain in the usage strip', () => {
  const grok = panel('grok', [], 18)

  assert.deepEqual(buildProjectDeckItems([grok]), [])
  assert.deepEqual(buildProjectUsageSummaries([grok]), [
    { agentType: 'grok', label: 'GROK', percent: 18 },
  ])
})

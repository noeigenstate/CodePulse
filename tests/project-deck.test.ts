import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import {
  buildProjectDeckGroups,
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

test('project deck groups the same workspace across providers with independent cards', () => {
  const path = 'F:/future/codepulse/CodePulse'
  const codex = runtime('codex', TurnState.TOOL_RUNNING, path, 20)
  const claude = runtime('claude_code', TurnState.DONE, path, 30, true)

  const groups = buildProjectDeckGroups([
    panel('codex', [
      { id: 'codex:cp', name: 'CodePulse', workspacePath: path, updatedAt: 20, agent: codex },
    ]),
    panel('claude_code', [
      { id: 'claude:cp', name: 'CodePulse', workspacePath: path, updatedAt: 30, agent: claude },
    ]),
  ])

  // One project group, but each agent keeps its own card (and its own state).
  assert.equal(groups.length, 1)
  assert.equal(groups[0]?.name, 'CodePulse')
  assert.equal(groups[0]?.cards.length, 2)
  // Provider order inside the group: Claude leads even though Codex arrived first.
  assert.deepEqual(
    groups[0]?.cards.map((card) => card.agentType),
    ['claude_code', 'codex'],
  )
  assert.equal(groups[0]?.cards[0]?.agent, claude)
  assert.equal(groups[0]?.cards[1]?.agent, codex)
})

test('project deck orders cards by provider rank regardless of attention state', () => {
  const grokAlarm = runtime('grok', TurnState.WAITING_PERMISSION, 'F:/grok-alarm', 10)
  const claudeQuiet = runtime('claude_code', TurnState.IDLE, 'F:/claude-quiet', 20)
  const codexDone = runtime('codex', TurnState.DONE, 'F:/codex-done', 30, true)
  const kimiActive = runtime('kimi', TurnState.THINKING, 'F:/kimi-active', 40)
  const agents = [grokAlarm, claudeQuiet, codexDone, kimiActive]
  const groups = buildProjectDeckGroups(
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
    groups.map((group) => group.name),
    ['claude-quiet', 'codex-done', 'kimi-active', 'grok-alarm'],
  )
})

test('project deck keeps first-seen order between cards of the same provider', () => {
  const older = runtime('codex', TurnState.IDLE, 'F:/older', 10)
  const newer = runtime('codex', TurnState.DONE, 'F:/newer', 50, true)
  const groups = buildProjectDeckGroups([
    panel('codex', [
      { id: 'codex:older', name: 'older', workspacePath: 'F:/older', updatedAt: 10, agent: older },
      { id: 'codex:newer', name: 'newer', workspacePath: 'F:/newer', updatedAt: 50, agent: newer },
    ]),
  ])

  // 先到先得:卡片位置不随状态或最近更新时间挪动。
  assert.deepEqual(
    groups.map((group) => group.name),
    ['older', 'newer'],
  )
})

test('a multi-agent group ranks by its front-most provider', () => {
  const shared = 'F:/shared'
  const groups = buildProjectDeckGroups([
    panel('codex', [
      {
        id: 'codex:only',
        name: 'codex-only',
        workspacePath: 'F:/codex-only',
        updatedAt: 10,
        agent: runtime('codex', TurnState.IDLE, 'F:/codex-only', 10),
      },
    ]),
    panel('kimi', [
      {
        id: 'kimi:shared',
        name: 'shared',
        workspacePath: shared,
        updatedAt: 20,
        agent: runtime('kimi', TurnState.THINKING, shared, 20),
      },
    ]),
    panel('claude_code', [
      {
        id: 'claude:shared',
        name: 'shared',
        workspacePath: shared,
        updatedAt: 30,
        agent: runtime('claude_code', TurnState.IDLE, shared, 30),
      },
    ]),
  ])

  // The shared project contains Claude, so the whole group leads Codex-only.
  assert.deepEqual(
    groups.map((group) => group.name),
    ['shared', 'codex-only'],
  )
  assert.deepEqual(
    groups[0]?.cards.map((card) => card.agentType),
    ['claude_code', 'kimi'],
  )
})

test('quota-only providers stay out of the project grid but remain in the usage strip', () => {
  const grok = panel('grok', [], 18)

  assert.deepEqual(buildProjectDeckGroups([grok]), [])
  assert.deepEqual(buildProjectUsageSummaries([grok]), [
    { agentType: 'grok', label: 'GROK', sevenDayPercent: 18 },
  ])
})

test('usage strip keeps the 5-hour and weekly windows side by side on one label', () => {
  const claude: AgentPanel = {
    agentType: 'claude_code',
    name: 'claude_code',
    updatedAt: 1,
    quotaMeters: [
      {
        id: 'default',
        updatedAt: 1,
        token: {
          accuracy: 'exact',
          rateLimits: {
            fiveHour: { usedPercent: 42, resetsAt: 2_000_000_000 },
            sevenDay: { usedPercent: 63, resetsAt: 2_000_000_000 },
          },
        },
      },
    ],
    workspaces: [],
  }

  assert.deepEqual(buildProjectUsageSummaries([claude]), [
    { agentType: 'claude_code', label: 'CLAUDE', fiveHourPercent: 42, sevenDayPercent: 63 },
  ])
})

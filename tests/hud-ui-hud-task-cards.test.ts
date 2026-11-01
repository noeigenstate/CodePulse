import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import { buildAgentPanels } from '../apps/hud/src/renderer/src/lib/displayAgents.js'
import {
  buildProjectDeckGroups,
  buildProjectUsageSummaries,
  projectCardTitle,
} from '../apps/hud/src/renderer/src/lib/projectDeck.js'
import { reconcileProjectOrder } from '../apps/hud/src/renderer/src/lib/projectOrder.js'
import {
  readTaskOrder,
  reconcileTaskOrder,
  writeTaskOrder,
} from '../apps/hud/src/renderer/src/lib/taskOrder.js'

function task(
  id: string,
  path = 'F:/Projects/Shared',
  extra: Partial<AgentRuntimeState> = {},
): AgentRuntimeState {
  return {
    agentType: 'codex',
    externalSessionId: id,
    workspacePath: path,
    taskTitle: `Task ${id}`,
    state: TurnState.TOOL_RUNNING,
    lastEventAt: 100,
    unread: false,
    toolCallCount: 1,
    needPermission: false,
    needUserInput: false,
    ...extra,
  }
}
const panels = (agents: AgentRuntimeState[]) => buildAgentPanels(agents, { perTask: true })
const ids = (agents: AgentRuntimeState[]) =>
  buildProjectDeckGroups(panels(agents)).flatMap((g) => g.cards.map((c) => c.id))

test('two native tasks in one project plus another project remain three independent named cards', () => {
  const agents = [
    task('mars', undefined, {
      taskTitle: '火星项目',
      token: { accuracy: 'exact', contextUsedPercent: 20 },
    }),
    task('music', undefined, {
      taskTitle: '音乐联觉体验',
      state: TurnState.WAITING_PERMISSION,
      token: { accuracy: 'exact', contextUsedPercent: 70 },
    }),
    task('embedded', 'F:/Projects/Device', { taskTitle: '嵌入式开发' }),
  ]
  const original = structuredClone(agents)
  const groups = buildProjectDeckGroups(panels(agents))
  assert.equal(groups.length, 2)
  assert.equal(groups[0]!.cards.length, 2)
  assert.deepEqual(
    groups.flatMap((g) => g.cards.map((c) => projectCardTitle(c, g))),
    ['火星项目', '音乐联觉体验', '嵌入式开发'],
  )
  assert.equal(new Set(ids(agents)).size, 3)
  assert.equal(groups[0]!.cards[0]!.agent.token?.contextUsedPercent, 20)
  assert.equal(groups[0]!.cards[1]!.agent.state, TurnState.WAITING_PERMISSION)
  assert.equal(groups[0]!.cards[1]!.agent.token?.contextUsedPercent, 70)
  assert.deepEqual(agents, original)
  // The optional legacy workspace overview keeps its old aggregation contract.
  assert.equal(buildAgentPanels(agents)[0]!.workspaces.length, 2)
})

test('native identities survive identical titles, nested directories, rename and mixed providers', () => {
  const agents = [
    task('a'),
    task('b', 'F:/Projects/Shared/child'),
    task('a', undefined, { agentType: 'claude_code' }),
  ]
  assert.equal(new Set(ids(agents)).size, 3)
  const before = ids([task('a'), task('b')])
  assert.deepEqual(ids([task('a', undefined, { taskTitle: 'renamed' }), task('b')]), before)
  assert.equal(ids([task('a'), task('a', undefined, { lastEventAt: 200 })]).length, 1)
  const fallback = buildProjectDeckGroups(
    panels([task('a', undefined, { taskTitle: undefined })]),
  )[0]!
  assert.equal(projectCardTitle(fallback.cards[0]!, fallback), 'Shared')
})

test('hidden sessions stay hidden without swallowing siblings or multiplying account quota', () => {
  const token = { accuracy: 'exact' as const, rateLimits: { sevenDay: { usedPercent: 12 } } }
  const result = panels([
    task('a', undefined, { taskHidden: true, token }),
    task('b', undefined, { token }),
  ])
  assert.equal(result[0]!.workspaces.length, 1)
  assert.equal(result[0]!.workspaces[0]!.agent.externalSessionId, 'b')
  assert.equal(buildProjectUsageSummaries(result).length, 1)
})

test('workspace-less named tasks and individual alerts survive; unnamed quota shells do not', () => {
  const result = panels([
    task('a', '', { taskTitle: 'named' }),
    task('b', '', { taskTitle: undefined, state: TurnState.WAITING_PERMISSION }),
    task('c', '', { taskTitle: undefined, state: TurnState.IDLE }),
  ])
  assert.deepEqual(
    result[0]!.workspaces.map((i) => i.agent.externalSessionId),
    ['a', 'b'],
  )
})

test('same-project task order survives state changes, input reordering, disappearance and restart', () => {
  const initial = [task('first'), task('second'), task('other', 'F:/Projects/Other')]
  const projects = reconcileProjectOrder(panels(initial), [])
  const tasks = reconcileTaskOrder(projects.panels, [])
  let saved = ''
  const storage = {
    getItem: () => saved,
    setItem: (_key: string, value: string) => {
      saved = value
    },
  }
  writeTaskOrder(storage, tasks.order)
  const restarted = readTaskOrder(storage)
  for (let i = 0; i < 20; i++) {
    const changed = [
      task('other', 'F:/Projects/Other'),
      task('second', undefined, { lastEventAt: 999 + i, state: TurnState.DONE, unread: true }),
      task('first', undefined, { taskTitle: `rename ${i}` }),
    ]
    const ordered = reconcileTaskOrder(
      reconcileProjectOrder(panels(changed), projects.order).panels,
      restarted,
    )
    assert.deepEqual(
      ordered.panels[0]!.workspaces.map((w) => w.agent.externalSessionId),
      ['first', 'second', 'other'],
    )
    assert.equal(ordered.changed, false)
  }
  const absent = reconcileTaskOrder(panels([initial[0]!]), restarted)
  assert.deepEqual(absent.order, restarted)
  const returned = reconcileTaskOrder(
    reconcileProjectOrder(
      panels([initial[2]!, task('new'), initial[1]!, initial[0]!]),
      projects.order,
    ).panels,
    absent.order,
  )
  assert.deepEqual(
    returned.panels[0]!.workspaces.map((w) => w.agent.externalSessionId),
    ['first', 'second', 'new', 'other'],
  )
})

test('task order discards malformed history and only evicts absent entries at the bound', () => {
  assert.deepEqual(readTaskOrder({ getItem: () => '{bad', setItem: () => {} }), [])
  const previous = Array.from({ length: 2048 }, (_, i) => `old-${i}`)
  const result = reconcileTaskOrder(panels([task('new')]), previous)
  assert.equal(result.order.length, 2048)
  assert.equal(result.order.includes('old-0'), false)
  assert.equal(result.order.at(-1), result.panels[0]!.workspaces[0]!.id)
  const unavailable = {
    getItem: () => {
      throw Error('blocked')
    },
    setItem: () => {
      throw Error('blocked')
    },
  }
  assert.deepEqual(readTaskOrder(unavailable), [])
  assert.doesNotThrow(() => writeTaskOrder(unavailable, result.order))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState, workspaceKey, type AgentType } from '@codepulse/shared'
import type {
  AgentPanel,
  AgentWorkspaceItem,
} from '../apps/desktop/src/renderer/src/lib/displayAgents.js'
import {
  latestProjectItem,
  PROJECT_ORDER_LIMIT,
  readProjectOrder,
  reconcileProjectOrder,
  writeProjectOrder,
} from '../apps/desktop/src/renderer/src/lib/projectOrder.js'

/** In-memory browser-storage substitute used by persistence tests. */
class MemoryStorage {
  private readonly values = new Map<string, string>()

  /** @inheritdoc */
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  /** @inheritdoc */
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

/**
 * Builds a minimal project card for stable-order tests.
 *
 * @param agentType CLI family that owns the card.
 * @param path Workspace path displayed by the card.
 * @param updatedAt Last runtime activity timestamp.
 * @returns A complete renderer project item.
 */
function project(agentType: AgentType, path: string, updatedAt: number): AgentWorkspaceItem {
  return {
    id: `${agentType}:${workspaceKey(path)}`,
    name: path.split(/[\\/]/).at(-1) ?? path,
    workspacePath: path,
    updatedAt,
    agent: {
      agentType,
      state: TurnState.THINKING,
      toolCallCount: 0,
      needPermission: false,
      needUserInput: false,
      lastEventAt: updatedAt,
      unread: false,
      workspacePath: path,
    },
  }
}

/**
 * Builds a minimal CLI panel containing the supplied projects.
 *
 * @param agentType CLI family represented by the panel.
 * @param workspaces Project cards in their incoming order.
 * @returns A complete renderer panel.
 */
function panel(agentType: AgentType, workspaces: AgentWorkspaceItem[]): AgentPanel {
  return {
    agentType,
    name: agentType,
    updatedAt: Math.max(0, ...workspaces.map((item) => item.updatedAt)),
    quotaMeters: [],
    workspaces,
  }
}

/** Returns workspace paths from the first panel for concise assertions. */
function panelPaths(result: ReturnType<typeof reconcileProjectOrder>): string[] {
  return result.panels[0]?.workspaces.map((item) => item.workspacePath ?? '') ?? []
}

test('project order stays fixed when activity timestamps change', () => {
  const first = reconcileProjectOrder(
    [
      panel('codex', [
        project('codex', 'E:/projects/b', 200),
        project('codex', 'E:/projects/a', 100),
      ]),
    ],
    [],
  )
  assert.deepEqual(panelPaths(first), ['E:/projects/b', 'E:/projects/a'])

  const refreshed = reconcileProjectOrder(
    [
      panel('codex', [
        project('codex', 'E:/projects/a', 900),
        project('codex', 'E:/projects/b', 300),
      ]),
    ],
    first.order,
  )

  assert.equal(refreshed.changed, false)
  assert.deepEqual(panelPaths(refreshed), ['E:/projects/b', 'E:/projects/a'])
})

test('new projects append while temporarily absent projects retain their positions', () => {
  const initial = reconcileProjectOrder(
    [panel('codex', [project('codex', 'E:/projects/a', 1), project('codex', 'E:/projects/b', 2)])],
    [],
  )
  const absent = reconcileProjectOrder(
    [panel('codex', [project('codex', 'E:/projects/a', 3)])],
    initial.order,
  )
  assert.deepEqual(absent.order, initial.order)

  const returned = reconcileProjectOrder(
    [
      panel('codex', [
        project('codex', 'E:/projects/c', 8),
        project('codex', 'E:/projects/b', 7),
        project('codex', 'E:/projects/a', 6),
      ]),
    ],
    absent.order,
  )

  assert.deepEqual(panelPaths(returned), ['E:/projects/a', 'E:/projects/b', 'E:/projects/c'])
})

test('the same normalized workspace shares one order across CLI panels', () => {
  const result = reconcileProjectOrder(
    [
      panel('codex', [
        project('codex', 'E:\\Projects\\Beta', 20),
        project('codex', 'E:\\Projects\\Alpha', 10),
      ]),
      panel('claude_code', [
        project('claude_code', 'e:/projects/alpha', 40),
        project('claude_code', 'e:/projects/beta', 30),
      ]),
    ],
    [],
  )

  assert.deepEqual(result.order, ['e:/projects/beta', 'e:/projects/alpha'])
  assert.deepEqual(
    result.panels[1]?.workspaces.map((item) => workspaceKey(item.workspacePath)),
    result.order,
  )
})

test('project order survives storage round trips and rejects malformed data', () => {
  const storage = new MemoryStorage()
  const order = ['E:/Projects/Beta', 'e:\\projects\\alpha', 'E:/PROJECTS/BETA']

  writeProjectOrder(storage, order)

  assert.deepEqual(readProjectOrder(storage), ['e:/projects/beta', 'e:/projects/alpha'])
  storage.setItem('codepulse:project-order-v1', '{invalid json')
  assert.deepEqual(readProjectOrder(storage), [])
})

test('project-order storage failures preserve safe in-memory behavior', () => {
  const unavailableStorage = {
    getItem: () => {
      throw new Error('storage blocked')
    },
    setItem: () => {
      throw new Error('storage full')
    },
  }

  assert.deepEqual(readProjectOrder(unavailableStorage), [])
  assert.doesNotThrow(() => writeProjectOrder(unavailableStorage, ['E:/projects/a']))
})

test('history trimming removes oldest absent projects but keeps every live project', () => {
  const previous = Array.from({ length: PROJECT_ORDER_LIMIT }, (_, index) =>
    workspaceKey(`E:/history/${index}`),
  )
  const livePath = 'E:/projects/current'
  const result = reconcileProjectOrder([panel('codex', [project('codex', livePath, 1)])], previous)

  assert.equal(result.order.length, PROJECT_ORDER_LIMIT)
  assert.equal(result.order.includes(workspaceKey('E:/history/0')), false)
  assert.equal(result.order.at(-1), workspaceKey(livePath))
})

test('latest project selection is independent from fixed visual order', () => {
  const first = project('codex', 'E:/projects/first', 100)
  const latest = project('codex', 'E:/projects/latest', 900)
  const items = [first, latest]

  assert.equal(latestProjectItem(items), latest)
  assert.deepEqual(items, [first, latest])
})

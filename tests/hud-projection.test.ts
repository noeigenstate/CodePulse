import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState, type AgentRuntimeState, type StatusSnapshot } from '@codepulse/shared'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'

const row: AgentRuntimeState = {
  agentType: 'codex',
  state: TurnState.TOOL_RUNNING,
  workspacePath: 'F:/project',
  externalSessionId: 'session-1',
  externalTurnId: 'turn-1',
  toolCallCount: 1,
  needPermission: false,
  needUserInput: false,
  lastEventAt: 1,
  unread: false,
}
const source = (agent = row): StatusSnapshot => ({
  overall: 'running',
  agents: [agent],
  updatedAt: 1,
})

test('HUD and classic use the same data while HUD hides remain local', () => {
  const projection = new HudProjection()
  const snapshot = source()
  assert.equal(
    projection.dismiss(snapshot, 'codex', row.workspacePath, row.externalSessionId),
    true,
  )
  assert.equal(projection.snapshot(snapshot).agents[0]?.taskHidden, true)
  assert.equal(snapshot.agents[0]?.taskHidden, undefined)
  assert.equal(
    projection.snapshot(source({ ...row, toolCallCount: 2 })).agents[0]?.taskHidden,
    undefined,
  )
})

test('quota-only updates cannot undo a HUD dismissal', () => {
  const projection = new HudProjection()
  projection.dismiss(source(), 'codex', row.workspacePath, row.externalSessionId)
  const refreshed = source({
    ...row,
    lastEventAt: 5000,
    token: { contextUsedPercent: 50, accuracy: 'exact' },
  })
  assert.equal(projection.snapshot(refreshed).agents[0]?.taskHidden, true)
})

test('HUD retention never hides an unread result or a waiting task', () => {
  const projection = new HudProjection()
  projection.setRetention(10)
  assert.equal(projection.setRetention(1), false)
  const now = 60 * 60_000
  for (const state of [TurnState.DONE, TurnState.WAITING_USER_INPUT]) {
    assert.equal(
      projection.snapshot(source({ ...row, state, unread: true }), now).agents[0]?.taskHidden,
      undefined,
    )
  }
  assert.equal(
    projection.snapshot(source({ ...row, state: TurnState.DONE, unread: false }), now).agents[0]
      ?.taskHidden,
    true,
  )
})

test('a provider without a HUD renderer remains present in the canonical snapshot', () => {
  const projection = new HudProjection()
  const snapshot = source({ ...row, agentType: 'opencode' })
  assert.equal(projection.snapshot(snapshot).agents.length, 0)
  assert.equal(snapshot.agents.length, 1)
})

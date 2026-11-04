import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_HUD_SETTINGS,
  TurnState,
  type AgentRuntimeState,
  type AgentEvent,
} from '@codepulse/shared'
import { reduce } from '../packages/core/src/state-machine/index.js'
import {
  hudAlertKeys,
  hudWindowBoundsForReveal,
  type HudDisplay,
} from '../apps/desktop/src/main/hud-window.js'

const primary: HudDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}
const left: HudDisplay = {
  id: 2,
  bounds: { x: -1280, y: 100, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 100, width: 1280, height: 984 },
}
const inside = (r: ReturnType<typeof hudWindowBoundsForReveal>, d: HudDisplay) => {
  assert.ok(r.x >= d.workArea.x && r.y >= d.workArea.y)
  assert.ok(r.x + r.width <= d.workArea.x + d.workArea.width)
  assert.ok(r.y + r.height <= d.workArea.y + d.workArea.height)
}
test('explicit reveal uses the supplied client display, including negative coordinates', () => {
  inside(hudWindowBoundsForReveal(primary), primary)
  const r = hudWindowBoundsForReveal(left)
  inside(r, left)
  assert.ok(r.x < 0)
})
test('reveal recovers stale coordinates from another/disconnected display', () => {
  for (const current of [
    { x: 50000, y: 50000, width: 470, height: 500 },
    { x: -1200, y: 200, width: 470, height: 500 },
  ]) {
    const r = hudWindowBoundsForReveal(primary, current)
    inside(r, primary)
    assert.equal(r.height, 500)
  }
})
test('reveal preserves a manually positioned HUD that still fits', () => {
  const current = { x: 550, y: 180, width: 470, height: 500 }
  assert.deepEqual(hudWindowBoundsForReveal(primary, current), current)
})
test('partly off-screen and oversized HUDs remain within the work area', () => {
  inside(hudWindowBoundsForReveal(primary, { x: 1800, y: 950, width: 470, height: 500 }), primary)
  inside(hudWindowBoundsForReveal(left, { x: -1000, y: 150, width: 3000, height: 3000 }), left)
})

const now = 1_800_000_000_000
const tools = DEFAULT_HUD_SETTINGS.visibleTools
const agent = (patch: Partial<AgentRuntimeState> = {}): AgentRuntimeState => ({
  agentType: 'codex',
  externalSessionId: 'session-one',
  state: TurnState.DONE,
  lastEventAt: now,
  unread: true,
  toolCallCount: 0,
  needPermission: false,
  needUserInput: false,
  ...patch,
})

test('alert keys include both waiting states even without unread, and unread terminal states', () => {
  for (const state of [TurnState.WAITING_PERMISSION, TurnState.WAITING_USER_INPUT]) {
    assert.equal(hudAlertKeys([agent({ state, unread: false })], tools, now).size, 1)
  }
  for (const state of [
    TurnState.DONE,
    TurnState.ERROR,
    TurnState.TIMEOUT,
    TurnState.USAGE_LIMITED,
  ]) {
    assert.equal(hudAlertKeys([agent({ state })], tools, now).size, 1)
    assert.equal(hudAlertKeys([agent({ state, unread: false })], tools, now).size, 0)
  }
})

test('quiet and active states never reveal the HUD', () => {
  for (const state of [
    TurnState.IDLE,
    TurnState.PROMPT_SUBMITTED,
    TurnState.THINKING,
    TurnState.TOOL_RUNNING,
  ]) {
    assert.equal(hudAlertKeys([agent({ state })], tools, now).size, 0)
  }
})

test('a running agent does not mask another agent alert', () => {
  const alert = agent({ agentType: 'claude_code' })
  assert.deepEqual(
    hudAlertKeys([agent({ state: TurnState.THINKING }), alert], tools, now),
    hudAlertKeys([alert], tools, now),
  )
})

test('alert keys respect tool visibility, unsupported tools, and hidden tasks', () => {
  assert.equal(hudAlertKeys([agent()], { ...tools, codex: false }, now).size, 0)
  assert.equal(hudAlertKeys([agent({ agentType: 'opencode' })], tools, now).size, 0)
  assert.equal(hudAlertKeys([agent({ taskHidden: true })], tools, now).size, 0)
  for (const agentType of ['codex', 'claude_code', 'grok', 'kimi', 'antigravity'] as const) {
    assert.equal(hudAlertKeys([agent({ agentType })], tools, now).size, 1)
  }
})

test('alerts expire after 60 seconds and invalid or future timestamps are ignored', () => {
  assert.equal(hudAlertKeys([agent({ lastEventAt: now - 60_000 })], tools, now).size, 1)
  for (const lastEventAt of [now - 60_001, now + 1, NaN, Infinity]) {
    assert.equal(hudAlertKeys([agent({ lastEventAt })], tools, now).size, 0)
  }
})

test('terminal time prevents session scans from creating a fresh key or refreshing an expired alert', () => {
  const terminalAt = now - 5_000
  assert.deepEqual(
    hudAlertKeys([agent({ terminalAt, lastEventAt: now - 100 })], tools, now),
    hudAlertKeys([agent({ terminalAt, lastEventAt: now })], tools, now),
  )
  assert.equal(hudAlertKeys([agent({ terminalAt: now - 60_001 })], tools, now).size, 0)
})

test('alert identity includes the session, provider, state and event time', () => {
  const original = agent()
  const keys = hudAlertKeys(
    [
      original,
      original,
      agent({ externalSessionId: 'session-two' }),
      agent({ agentType: 'claude_code' }),
      agent({ state: TurnState.ERROR }),
      agent({ terminalAt: now - 1 }),
    ],
    tools,
    now,
  )
  assert.equal(keys.size, 5)
  assert.deepEqual(
    hudAlertKeys([agent({ workspacePath: 'E:/transient/cwd' })], tools, now),
    hudAlertKeys([original], tools, now),
  )
})

test('path-only agents use their workspace identity without changing the input', () => {
  const first = Object.freeze(agent({ externalSessionId: undefined, workspacePath: 'E:/one' }))
  const second = agent({ externalSessionId: undefined, workspacePath: 'E:/two' })
  assert.equal(hudAlertKeys([first, second], tools, now).size, 2)
  assert.equal(first.workspacePath, 'E:/one')
})

for (const eventType of ['permission_request', 'user_input_required'] as const) {
  test(`${eventType} keeps its alert key across token updates and repeated requests`, () => {
    const event: AgentEvent = {
      id: 'waiting',
      source: 'codex',
      externalSessionId: 'session-one',
      timestamp: now - 1000,
      eventType,
      toolName: 'Bash',
      message: 'Request command',
    }
    const waiting = reduce(
      agent({ state: TurnState.THINKING, unread: false, externalTurnId: 'turn-one' }),
      event,
    ).next
    const before = hudAlertKeys([waiting], tools, now)
    assert.equal(before.size, 1)
    for (const patch of [
      { eventType: 'token_snapshot', internal: { sessionSync: true, activityRefresh: true } },
      { eventType: 'token_snapshot', internal: { sessionSync: true } },
      { eventType: 'token_snapshot' },
      { eventType },
    ] as const) {
      const next = reduce(waiting, { ...event, id: 'updated', timestamp: now - 1, ...patch }).next
      assert.equal(next.state, waiting.state)
      assert.deepEqual(hudAlertKeys([next], tools, now), before)
    }
    // PermissionRequest and permission_prompt describe one prompt with different tool and text.
    for (const patch of [{ toolName: undefined }, { activity: 'Claude needs your permission' }]) {
      assert.deepEqual(hudAlertKeys([{ ...waiting, ...patch }], tools, now), before)
    }
    assert.notDeepEqual(
      hudAlertKeys([{ ...waiting, externalTurnId: 'turn-two' }], tools, now),
      before,
    )
  })
}

test('presence keys retain an ongoing wait after freshness expires and forget it when it ends', () => {
  const waiting = agent({
    state: TurnState.WAITING_PERMISSION,
    terminalAt: undefined,
    externalTurnId: 'turn-one',
    toolName: 'Bash',
  })
  const initial = hudAlertKeys([waiting], tools, now)
  assert.equal(hudAlertKeys([waiting], tools, now + 60_001).size, 0)
  const present = hudAlertKeys([waiting], tools, now + 60_001, false)
  assert.deepEqual(present, initial)
  assert.deepEqual(
    hudAlertKeys([{ ...waiting, lastEventAt: now + 60_001 }], tools, now + 60_001),
    present,
  )
  assert.equal(
    hudAlertKeys([{ ...waiting, state: TurnState.THINKING }], tools, now + 60_001, false).size,
    0,
  )
})

test('stale presence keys still exclude invisible, hidden and acknowledged alerts', () => {
  const old = agent({ lastEventAt: now - 70_000 })
  assert.equal(hudAlertKeys([old], tools, now, false).size, 1)
  assert.equal(hudAlertKeys([old], { ...tools, codex: false }, now, false).size, 0)
  assert.equal(hudAlertKeys([{ ...old, taskHidden: true }], tools, now, false).size, 0)
  assert.equal(hudAlertKeys([{ ...old, unread: false }], tools, now, false).size, 0)
})

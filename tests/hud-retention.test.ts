import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { TurnState, normalizeDeviceDisplay, type AgentEvent } from '@codepulse/shared'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'

const start = 1_000_000
const minute = 60_000
function setup() {
  const hub = new StatusHub()
  const hud = new HudProjection()
  hub.setPresentationRetention((agent, now) => hud.shouldRetain(agent, now))
  let sequence = 0
  const send = (
    eventType: AgentEvent['eventType'],
    timestamp = start,
    extra: Partial<AgentEvent> = {},
  ) =>
    hub.ingest({
      id: `event-${++sequence}`,
      source: 'codex',
      eventType,
      externalSessionId: 'session',
      cwd: 'F:/test/project',
      timestamp,
      ...extra,
    })
  const tick = (now: number) => (hub as unknown as { tick(now: number): void }).tick(now)
  const shown = (now: number) => hud.snapshot(hub.snapshotForPresentation(now), now)
  const visible = (now: number) => shown(now).agents.filter((agent) => !agent.taskHidden)
  return { hub, hud, send, tick, shown, visible }
}

test('HUD default keeps idle cards for 30 minutes while classic/device still expire at five', () => {
  const { hub, send, tick, visible } = setup()
  send('session_start')
  tick(start + 6 * minute)
  assert.equal(hub.snapshot(start + 6 * minute).agents.length, 0)
  assert.equal(toDeviceStatusV1(hub.snapshot(start + 6 * minute), normalizeDeviceDisplay({})).threads?.length, 0)
  assert.equal(visible(start + 6 * minute).length, 1)
  tick(start + 30 * minute - 1)
  assert.equal(visible(start + 30 * minute - 1).length, 1)
  tick(start + 30 * minute)
  assert.equal(visible(start + 30 * minute).length, 0)
})

test('each HUD retention setting applies to idle, cancelled and acknowledged terminal cards', () => {
  const events = [
    'session_start',
    'turn_cancelled',
    'turn_stop',
    'turn_error',
    'turn_timeout',
    'usage_limited',
  ] as const
  for (const duration of [10, 30, 60, 120, 240])
    for (const event of events) {
      const { hub, hud, send, tick, visible } = setup()
      hud.setRetention(duration)
      if (event !== 'session_start') send('prompt_submit', start - 1)
      send(event)
      hub.acknowledge('codex', 'F:/test/project')
      tick(start + duration * minute - 1)
      assert.equal(
        visible(start + duration * minute - 1).length,
        1,
        `${event} at ${duration} minutes`,
      )
      tick(start + duration * minute)
      assert.equal(visible(start + duration * minute).length, 0, `${event} should now expire`)
    }
})

test('unread terminal results survive old pruning and CLI close until acknowledgement', () => {
  for (const event of ['turn_stop', 'turn_error', 'turn_timeout', 'usage_limited'] as const) {
    const { hub, hud, send, tick, visible } = setup()
    send('prompt_submit', start - 1)
    send(event, start, { message: 'result' })
    const terminal = hub.snapshot(start).agents[0]!
    send('session_end', start + minute)
    assert.equal(hub.snapshot(start + minute).agents[0]?.state, terminal.state)
    tick(start + 24 * 60 * minute)
    assert.equal(hub.snapshot(start + 24 * 60 * minute).agents.length, 0)
    assert.equal(visible(start + 24 * 60 * minute)[0]?.state, terminal.state)
    assert.equal(visible(start + 24 * 60 * minute)[0]?.unread, true)
    assert.equal(visible(start + 24 * 60 * minute)[0]?.terminalAt, start)
    hub.acknowledgeRows(
      hud.rowsForProject(hub.snapshotForPresentation(), 'codex', 'F:/test/project'),
    )
    tick(start + 24 * 60 * minute + 1)
    assert.equal(visible(start + 24 * 60 * minute + 1).length, 0)
  }
})

test('acknowledgement before the deadline retains a quiet card for the remainder of its interval', () => {
  const { hub, send, tick, visible } = setup()
  send('prompt_submit', start - 1)
  send('turn_stop')
  tick(start + 6 * minute)
  hub.acknowledgeRows(hub.snapshotForPresentation().agents)
  tick(start + 29 * minute)
  assert.equal(visible(start + 29 * minute)[0]?.unread, false)
  tick(start + 30 * minute)
  assert.equal(visible(start + 30 * minute).length, 0)
})

test('quota refreshes preserve source unread/expiry anchor and do not extend quiet card retention', () => {
  const { hub, send, tick, visible } = setup()
  send('prompt_submit', start - 1)
  send('turn_stop')
  send('token_snapshot', start + minute, {
    token: { accuracy: 'exact', rateLimits: { sevenDay: { usedPercent: 12 } } },
    internal: { quotaRefresh: true, sessionSync: true },
  })
  tick(start + 6 * minute)
  assert.equal(hub.snapshot().agents[0]?.taskHidden, true)
  assert.equal(hub.snapshot().agents[0]?.unread, false)
  assert.equal(visible(start + 6 * minute)[0]?.unread, true)
  hub.acknowledgeRows(hub.snapshotForPresentation().agents)
  send('token_snapshot', start + 29 * minute, {
    token: { accuracy: 'exact', rateLimits: { sevenDay: { usedPercent: 13 } } },
    internal: { quotaRefresh: true, sessionSync: true },
  })
  assert.equal(visible(start + 29 * minute)[0]?.token?.rateLimits?.sevenDay?.usedPercent, 13)
  tick(start + 30 * minute)
  assert.equal(visible(start + 30 * minute).length, 0)
  assert.equal(
    hub.snapshotForPresentation().agents[0]?.token?.rateLimits?.sevenDay?.usedPercent,
    13,
  )
})

test('real activity restores a retained project to both surfaces without changing its HUD workspace', () => {
  const { hub, send, tick, visible } = setup()
  send('session_start')
  visible(start)
  tick(start + 6 * minute)
  assert.equal(hub.snapshot().agents.length, 0)
  send('prompt_submit', start + 7 * minute, { cwd: 'F:/temporary/command' })
  assert.equal(hub.snapshot().agents[0]?.state, TurnState.PROMPT_SUBMITTED)
  assert.equal(visible(start + 7 * minute)[0]?.workspacePath, 'F:/test/project')
})

test('explicit HUD dismissal stays local and releases expired source retention', () => {
  const { hub, hud, send, tick, visible } = setup()
  send('prompt_submit', start - 1)
  send('turn_stop')
  const source = hub.snapshotForPresentation(start)
  hud.dismiss(source, 'codex', 'F:/test/project', 'session')
  assert.equal(visible(start + minute).length, 0)
  assert.equal(hub.snapshot(start + minute).agents[0]?.unread, true)
  tick(start + 6 * minute)
  assert.equal(hub.snapshotForPresentation().agents.length, 0)
})

test('auxiliary-session exclusion removes retained HUD rows without resurrecting a cached task', () => {
  const { hub, send, tick, visible } = setup()
  send('prompt_submit', start - 1)
  send('turn_stop')
  tick(start + 6 * minute)
  assert.equal(visible(start + 6 * minute).length, 1)
  hub.excludeAuxiliarySession('codex', 'session')
  assert.equal(visible(start + 6 * minute).length, 0)
  send('turn_stop', start + 7 * minute)
  assert.equal(visible(start + 7 * minute).length, 0)
})

test('quiet session close stays idle and cancelled unread does not become a permanent alert', () => {
  const { hub, send, tick, visible } = setup()
  send('prompt_submit', start - 1)
  send('turn_cancelled')
  send('session_end', start + minute)
  assert.equal(hub.snapshot().agents[0]?.state, TurnState.IDLE)
  assert.equal(hub.snapshot().agents[0]?.unread, false)
  tick(start + 31 * minute)
  assert.equal(visible(start + 31 * minute).length, 0)
})

test('long abandoned waits remain visible as unread timeout results on the HUD', () => {
  const { send, tick, visible } = setup()
  send('permission_request')
  tick(start + 31 * minute)
  assert.equal(visible(start + 31 * minute)[0]?.state, TurnState.TIMEOUT)
  tick(start + 61 * minute)
  assert.equal(visible(start + 61 * minute)[0]?.unread, true)
})

test('HUD retention does not retain unsupported providers or alter a host without that surface', () => {
  const { hub, send, tick } = setup()
  send('session_start', start, { source: 'opencode' })
  tick(start + 6 * minute)
  assert.equal(hub.snapshotForPresentation().agents.length, 0)
  const plain = new StatusHub()
  plain.ingest({ id: 'start', source: 'codex', eventType: 'session_start', timestamp: start })
  ;(plain as unknown as { tick(now: number): void }).tick(start + 6 * minute)
  assert.equal(plain.snapshotForPresentation().agents.length, 0)
})

test('retention changes take effect without waiting for another agent event', () => {
  const { hub, hud, send, tick, visible } = setup()
  send('session_start')
  tick(start + 6 * minute)
  assert.equal(visible(start + 15 * minute).length, 1)
  hud.setRetention(10)
  assert.equal(visible(start + 15 * minute).length, 0)
  tick(start + 15 * minute)
  assert.equal(hub.snapshotForPresentation().agents.length, 0)
})

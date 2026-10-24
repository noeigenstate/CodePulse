import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'

function setup() {
  const hub = new StatusHub(),
    hud = new HudProjection()
  for (const [id, provider] of [
    ['a', 'codex'],
    ['b', 'codex'],
    ['a', 'claude_code'],
  ] as const) {
    hub.ingest({
      id: `start-${id}-${provider}`,
      source: provider,
      eventType: 'prompt_submit',
      externalSessionId: id,
      cwd: 'F:/Shared',
      timestamp: 1,
    })
    hub.ingest({
      id: `stop-${id}-${provider}`,
      source: provider,
      eventType: 'turn_stop',
      externalSessionId: id,
      cwd: 'F:/Shared',
      timestamp: 2,
    })
  }
  hud.snapshot(hub.snapshot())
  return { hub, hud }
}

test('reading one task leaves same-directory and other-provider reminders unread', () => {
  const { hub, hud } = setup()
  const source = hub.snapshot()
  // The session is authoritative even if the displayed path differs from cwd.
  hub.acknowledgeRows(hud.rowsForCard(source, 'codex', 'F:/OldDisplayPath', 'a'))
  assert.deepEqual(
    Object.fromEntries(
      hub.snapshot().agents.map((a) => [`${a.agentType}:${a.externalSessionId}`, a.unread]),
    ),
    {
      'codex:a': false,
      'codex:b': true,
      'claude_code:a': true,
    },
  )
  assert.ok(source.agents.every((a) => a.unread))
})

test('unknown or empty explicit session cannot clear siblings; legacy project acknowledgement is preserved', () => {
  const { hub, hud } = setup()
  for (const session of ['absent', '', ' ']) {
    const rows = hud.rowsForCard(hub.snapshot(), 'codex', 'F:/Shared', session)
    assert.equal(rows.length, 0)
    hub.acknowledgeRows(rows)
  }
  assert.ok(hub.snapshot().agents.every((a) => a.unread))
  hub.acknowledgeRows(hud.rowsForCard(hub.snapshot(), 'codex', 'F:/Shared'))
  assert.ok(
    hub
      .snapshot()
      .agents.filter((a) => a.agentType === 'codex')
      .every((a) => !a.unread),
  )
  assert.equal(hub.snapshot().agents.find((a) => a.agentType === 'claude_code')!.unread, true)
})

test('dismissing one session hides only that task in the HUD projection', () => {
  const { hub, hud } = setup()
  const source = hub.snapshot()
  hud.dismiss(source, 'codex', 'F:/Shared', 'a')
  const shown = hud.snapshot(source).agents
  assert.equal(
    shown.find((a) => a.agentType === 'codex' && a.externalSessionId === 'a')!.taskHidden,
    true,
  )
  assert.equal(
    shown.find((a) => a.agentType === 'codex' && a.externalSessionId === 'b')!.taskHidden,
    false,
  )
  assert.ok(source.agents.every((a) => !a.taskHidden && a.unread))
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusHub, normalizeEvent, toDeviceStatusV1 } from '@codepulse/core'
import { SessionSyncService } from '@codepulse/local-server'
import {
  normalizeDeviceDisplay,
  buildWorkPresentation,
  buildProjectDeckGroups,
  TurnState,
  type AgentEventInput,
} from '@codepulse/shared'
import { HudProjection } from '../apps/desktop/src/main/hud-projection.js'

const config = normalizeDeviceDisplay({ mode: 'hud' })
const base = 1_800_000_000_000
const identity = {
  source: 'codex' as const,
  externalSessionId: 'passive-fixture',
  workspacePath: 'C:/fixture/passive',
}
function ingest(
  hub: StatusHub,
  event: Partial<AgentEventInput> & Pick<AgentEventInput, 'eventType'>,
) {
  hub.ingest(normalizeEvent({ ...identity, timestamp: base, ...event }))
}
function surfaces(hub: StatusHub, now = base) {
  const hud = new HudProjection().snapshot(hub.snapshotForPresentation(now), now)
  return {
    hudCards: buildProjectDeckGroups(buildWorkPresentation(hud).panels).flatMap(
      (group) => group.cards,
    ).length,
    device: toDeviceStatusV1(hud, config),
  }
}

test('opening a session and reading its context/quotas never admits a HUD or device task', () => {
  const hub = new StatusHub(),
    notifications: unknown[] = []
  hub.on('notification', (n) => notifications.push(n))
  ingest(hub, { eventType: 'session_start' })
  ingest(hub, {
    eventType: 'token_snapshot',
    timestamp: base + 1000,
    model: 'fixture-model',
    token: {
      input: 100,
      total: 100,
      accuracy: 'exact',
      rateLimits: { sevenDay: { usedPercent: 21, windowMinutes: 10080 } },
    },
    internal: { sessionSync: true, activityRefresh: true },
  })
  assert.equal(surfaces(hub, base + 1000).hudCards, 0)
  assert.equal(surfaces(hub, base + 1000).device.threadTotal, 0)
  assert.equal(hub.findSession('codex', identity.externalSessionId)?.taskHidden, true)
  assert.equal(
    hub.findSession('codex', identity.externalSessionId)?.token?.rateLimits?.sevenDay?.usedPercent,
    21,
  )
  assert.equal(notifications.length, 0)
  ingest(hub, { eventType: 'session_end', timestamp: base + 1500 })
  assert.equal(hub.findSession('codex', identity.externalSessionId)?.lastEventAt, base + 1000)
  assert.equal(surfaces(hub, base + 1500).device.threadTotal, 0)
  ingest(hub, { eventType: 'prompt_submit', externalTurnId: 'real-prompt', timestamp: base + 2000 })
  assert.equal(surfaces(hub, base + 2000).hudCards, 1)
  assert.equal(surfaces(hub, base + 2000).device.threadTotal, 1)
})

test('browse/resume hooks preserve completed unread state and its original retention timestamp', () => {
  const hub = new StatusHub()
  ingest(hub, { eventType: 'prompt_submit', externalTurnId: 'done' })
  ingest(hub, { eventType: 'turn_stop', externalTurnId: 'done', timestamp: base + 1000 })
  const before = hub.findSession('codex', identity.externalSessionId)!
  ingest(hub, { eventType: 'session_start', timestamp: base + 10_000 })
  const after = hub.findSession('codex', identity.externalSessionId)!
  assert.equal(after.state, TurnState.DONE)
  assert.equal(after.unread, true)
  assert.equal(after.terminalAt, before.terminalAt)
  assert.equal(after.lastEventAt, before.lastEventAt)
})

test('a reopened expired result stays hidden; a new prompt in that same session reappears', () => {
  const hub = new StatusHub()
  ingest(hub, { eventType: 'prompt_submit', externalTurnId: 'old' })
  ingest(hub, {
    eventType: 'token_snapshot',
    token: { accuracy: 'exact', rateLimits: { sevenDay: { usedPercent: 21 } } },
  })
  ingest(hub, { eventType: 'turn_stop', externalTurnId: 'old', timestamp: base + 1000 })
  const later = base + 24 * 3600_000
  ;(hub as unknown as { tick(now: number): void }).tick(later)
  assert.equal(hub.findSession('codex', identity.externalSessionId)?.taskHidden, true)
  ingest(hub, { eventType: 'session_start', timestamp: later })
  ingest(hub, {
    eventType: 'token_snapshot',
    timestamp: later + 1000,
    internal: { sessionSync: true },
    turnTiming: {
      state: 'completed',
      externalTurnId: 'old',
      startedAt: base,
      elapsedMs: 1000,
      observedAt: base + 1000,
    },
  })
  assert.equal(surfaces(hub, later + 1000).hudCards, 0)
  assert.equal(surfaces(hub, later + 1000).device.threadTotal, 0)
  ingest(hub, { eventType: 'prompt_submit', externalTurnId: 'new', timestamp: later + 2000 })
  assert.equal(surfaces(hub, later + 2000).device.threadTotal, 1)
})

test('cold native discovery admits a recent real turn, but not a stale abandoned active record', () => {
  for (const age of [2000, 3600_000]) {
    const hub = new StatusHub(),
      startedAt = base - age
    ingest(hub, {
      eventType: 'session_start',
      internal: { sessionSync: true },
      turnTiming: { state: 'active', externalTurnId: 'native', startedAt, observedAt: startedAt },
    })
    assert.equal(surfaces(hub).device.threadTotal, age === 2000 ? 1 : 0)
  }
})

test('metadata refresh does not alter a genuine approval/input request', () => {
  for (const type of ['permission_request', 'user_input_required'] as const) {
    const hub = new StatusHub()
    ingest(hub, { eventType: 'prompt_submit', externalTurnId: 'turn' })
    ingest(hub, { eventType: type, timestamp: base + 1000 })
    const before = hub.findSession('codex', identity.externalSessionId)!
    ingest(hub, { eventType: 'session_start', timestamp: base + 2000 })
    ingest(hub, {
      eventType: 'token_snapshot',
      timestamp: base + 3000,
      internal: { sessionSync: true },
    })
    const after = hub.findSession('codex', identity.externalSessionId)!
    assert.equal(after.state, before.state)
    assert.equal(after.lastEventAt, before.lastEventAt)
    assert.equal(surfaces(hub, base + 3000).device.threadTotal, 1)
  }
})

async function fixture(t: { after(fn: () => Promise<void>): void }, active = false) {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-passive-')),
    dir = join(home, 'sessions', '2026', '11', '02')
  await mkdir(dir, { recursive: true })
  let now = Date.now()
  const file = join(dir, 'rollout-fixture.jsonl'),
    session = 'passive-native-fixture'
  const old = now - 3600_000
  const head = [
    { type: 'session_meta', payload: { id: session, cwd: 'C:/fixture/passive-native' } },
    {
      type: 'event_msg',
      timestamp: new Date(old).toISOString(),
      payload: { type: 'task_started', turn_id: 'old', started_at: old },
    },
    ...(active
      ? []
      : [
          {
            type: 'event_msg',
            timestamp: new Date(old + 1000).toISOString(),
            payload: {
              type: 'task_complete',
              turn_id: 'old',
              duration_ms: 1000,
              completed_at: old + 1000,
            },
          },
        ]),
    {
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 258400,
          last_token_usage: { input_tokens: 100, total_tokens: 100 },
        },
      },
    },
    {
      type: 'turn_context',
      timestamp: new Date(old).toISOString(),
      payload: { model: 'fixture-model', effort: 'high' },
    },
  ]
  await writeFile(file, head.map((row) => JSON.stringify(row)).join('\n') + '\n')
  await utimes(file, new Date(now), new Date(now))
  const hub = new StatusHub(),
    events: AgentEventInput[] = []
  hub.on('event', (event) => events.push(event))
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    disableWatch: true,
    now: () => now,
    codexProcessAlive: () => true,
  })
  t.after(async () => {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  })
  return {
    hub,
    sync,
    events,
    session,
    get now() {
      return now
    },
    async write(row: unknown) {
      now += 1000
      await appendFile(file, JSON.stringify(row) + '\n')
      await utimes(file, new Date(now), new Date(now))
    },
  }
}

test('real Codex scan keeps completed browsing invisible through timestamp/model/context rewrites', async (t) => {
  const f = await fixture(t)
  await f.sync.syncNow(['codex'])
  assert.equal(surfaces(f.hub, f.now).device.threadTotal, 0)
  await f.write({
    type: 'turn_context',
    timestamp: new Date(f.now + 1000).toISOString(),
    payload: { model: 'new-selection', effort: 'low' },
  })
  await f.sync.syncNow(['codex'])
  assert.equal(
    f.hub.findSession('codex', f.session)?.model,
    'new-selection',
    'metadata still synchronizes',
  )
  assert.equal(surfaces(f.hub, f.now).device.threadTotal, 0)
  assert.equal(f.events.at(-1)?.internal?.activityRefresh, undefined)
  await f.write({
    type: 'event_msg',
    timestamp: new Date(f.now + 1000).toISOString(),
    payload: { type: 'task_started', turn_id: 'new', started_at: f.now + 1000 },
  })
  await f.sync.syncNow(['codex'])
  assert.equal(surfaces(f.hub, f.now).hudCards, 1)
  assert.equal(surfaces(f.hub, f.now).device.threadTotal, 1)
})

test('opening an abandoned active Codex session does not recover a timeout or create new work', async (t) => {
  const f = await fixture(t, true)
  await f.sync.syncNow(['codex'])
  assert.equal(surfaces(f.hub, f.now).device.threadTotal, 0)
  await f.write({
    type: 'thread_settings_applied',
    timestamp: new Date(f.now + 1000).toISOString(),
    payload: { model: 'renamed-model' },
  })
  await f.sync.syncNow(['codex'])
  assert.equal(surfaces(f.hub, f.now).device.threadTotal, 0)
  assert.equal(f.events.at(-1)?.internal?.activityRefresh, undefined)
  await f.write({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model_context_window: 258400,
        last_token_usage: { input_tokens: 500, output_tokens: 10, total_tokens: 510 },
      },
    },
  })
  await f.sync.syncNow(['codex'])
  assert.equal(
    surfaces(f.hub, f.now).device.threadTotal,
    1,
    'new measured execution can restore missed hooks',
  )
})

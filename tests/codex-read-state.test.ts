import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatusHub, normalizeEvent, toDeviceStatusV1 } from '@codepulse/core'
import { normalizeDeviceDisplay } from '@codepulse/shared'
import {
  CodexReadStateSync,
  parseCodexReadState,
} from '../packages/local-server/src/codex-read-state.js'

const identity = 'a'.repeat(64),
  host = 'local:' + 'b'.repeat(64)
const state = (ids: string[], account = identity, hostKey = host) => ({
  'electron-thread-read-state-v1': {
    version: 1,
    unreadByIdentity: { [account]: { [hostKey]: ids } },
  },
})
function fixture(t: { after(fn: () => void): void }) {
  const hub = new StatusHub()
  let native: unknown = state([]),
    now = Date.now()
  const service = new CodexReadStateSync({ hub, intervalMs: 0, readState: async () => native })
  t.after(() => service.stop())
  const event = (
    session: string,
    eventType: 'prompt_submit' | 'turn_stop' | 'permission_request' | 'user_input_required',
    turn = 'turn-1',
  ) => {
    hub.ingest(
      normalizeEvent({
        source: 'codex',
        externalSessionId: session,
        externalTurnId: turn,
        eventType,
        timestamp: ++now,
        workspacePath: '/same-project',
      }),
    )
  }
  const done = (session: string, turn = 'turn-1') => {
    event(session, 'prompt_submit', turn)
    event(session, 'turn_stop', turn)
  }
  const row = (id: string) => hub.snapshot().agents.find((a) => a.externalSessionId === id)!
  return {
    hub,
    service,
    event,
    done,
    row,
    set: (value: unknown) => {
      native = value
    },
  }
}

test('native read clears only the same completed task; desktop/device share the result', async (t) => {
  const f = fixture(t)
  f.done('a')
  f.done('b')
  f.set(state(['a', 'b']))
  await f.service.start()
  const before = f.hub.snapshot()
  let events = 0,
    notifications = 0,
    updates = 0
  f.hub.on('event', () => events++)
  f.hub.on('notification', () => notifications++)
  f.hub.on('status', () => updates++)
  f.set(state(['b']))
  await f.service.syncNow()
  assert.deepEqual(f.row('a'), {
    ...before.agents.find((a) => a.externalSessionId === 'a'),
    unread: false,
  })
  assert.equal(f.row('b').unread, true)
  assert.deepEqual(
    f.hub.snapshot().agents.map((a) => a.externalSessionId),
    before.agents.map((a) => a.externalSessionId),
  )
  assert.equal(events, 0)
  assert.equal(notifications, 0)
  assert.equal(updates, 1)
  const device = toDeviceStatusV1(f.hub.snapshot(), normalizeDeviceDisplay({}))
  assert.ok(device.threads)
  await f.service.syncNow()
  assert.equal(updates, 1)
})

test('startup absence is unknown; only a witnessed unread to read transition clears', async (t) => {
  const f = fixture(t)
  f.done('a')
  await f.service.start()
  await f.service.syncNow()
  assert.equal(f.row('a').unread, true)
  f.set(state(['a']))
  await f.service.syncNow()
  f.set(state([]))
  await f.service.syncNow()
  assert.equal(f.row('a').unread, false)
})

test('new turns and newer completions cannot inherit an earlier read transition', async (t) => {
  const f = fixture(t)
  f.done('a')
  f.done('b')
  f.set(state(['a', 'b']))
  await f.service.start()
  f.done('a', 'turn-2')
  f.event('b', 'prompt_submit', 'turn-2')
  f.set(state([]))
  await f.service.syncNow()
  assert.equal(f.row('a').unread, true)
  assert.equal(f.row('b').state, 'PROMPT_SUBMITTED')
})

test('viewing never clears an actual approval or user-input request', async (t) => {
  const f = fixture(t)
  f.done('a')
  f.done('b')
  f.set(state(['a', 'b']))
  await f.service.start()
  f.event('a', 'permission_request')
  f.event('b', 'user_input_required')
  const before = f.hub.snapshot().agents
  f.set(state([]))
  await f.service.syncNow()
  assert.deepEqual(f.hub.snapshot().agents, before)
})

test('malformed files, account/host changes and logout reset the baseline', async (t) => {
  for (const invalid of [
    null,
    {},
    state([], 'c'.repeat(64)),
    state([], identity, 'local:' + 'd'.repeat(64)),
  ]) {
    const f = fixture(t)
    f.done('a')
    f.set(state(['a']))
    await f.service.start()
    f.set(invalid)
    await f.service.syncNow()
    f.set(state([]))
    await f.service.syncNow()
    assert.equal(f.row('a').unread, true)
  }
})

test('unsupported/ambiguous scopes and remote-host removals are not local read evidence', async (t) => {
  const ambiguous = state(['a'])
  ambiguous['electron-thread-read-state-v1'].unreadByIdentity['c'.repeat(64)] = { [host]: [] }
  assert.equal(parseCodexReadState(ambiguous), undefined)
  assert.equal(parseCodexReadState(state([], identity, 'durable:' + 'b'.repeat(64))), undefined)
  const f = fixture(t)
  f.done('a')
  f.set(state(['a']))
  await f.service.start()
  const remote = state(['a'])
  remote['electron-thread-read-state-v1'].unreadByIdentity[identity]!['durable:remote'] = []
  f.set(remote)
  await f.service.syncNow()
  assert.equal(f.row('a').unread, true)
})

test('stop cancels an in-flight read without acknowledging anything', async (t) => {
  const hub = new StatusHub()
  let release!: (value: unknown) => void
  const service = new CodexReadStateSync({
    hub,
    intervalMs: 0,
    readState: () =>
      new Promise((r) => {
        release = r
      }),
  })
  t.after(() => service.stop())
  const starting = service.start()
  service.stop()
  release(state([]))
  await starting
  assert.deepEqual(hub.snapshot().agents, [])
})

test('actual file is read only; a partial rewrite never clears results', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-read-state-'))
  t.after(() => {
    void rm(home, { recursive: true, force: true })
  })
  const f = fixture(t)
  f.done('a')
  const file = join(home, '.codex-global-state.json')
  await writeFile(file, JSON.stringify(state(['a'])))
  const service = new CodexReadStateSync({ hub: f.hub, codexHome: home, intervalMs: 0 })
  t.after(() => service.stop())
  await service.start()
  await writeFile(file, '{"electron-thread-read-state-v1":')
  await service.syncNow()
  await writeFile(file, JSON.stringify(state([])))
  await service.syncNow()
  assert.equal(f.row('a').unread, true)
  await writeFile(file, JSON.stringify(state(['a'])))
  await service.syncNow()
  await writeFile(file, JSON.stringify(state([])))
  await service.syncNow()
  assert.equal(f.row('a').unread, false)
})

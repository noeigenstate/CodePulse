import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DEVICE_DISPLAY, DEFAULT_INK_PLAN, normalizeAmbient, type InkScreenStatus } from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { startDeviceServer, DEVICE_AUTH_HEADER, DEVICE_STATUS_PATH } from '@codepulse/local-server'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'
import { ProductShell } from '../apps/desktop/src/main/product-shell.js'
import { applyInk, endInkTemporary } from '../apps/desktop/src/main/ink-apply.js'
import { computeInkStatus, InkStatusRuntime, type InkStatusInput } from '../apps/desktop/src/main/ink-status.js'

const base: Omit<InkStatusInput, 'now'> = {
  plan: { ...DEFAULT_INK_PLAN, mode: 'single' }, serverEnabled: true, lastSeenAt: null,
  projected: {}, ambientTemporary: null, assistantUntil: 0, ambientPausedReason: '',
}
const noon = new Date(2026, 10, 2, 12).getTime()
function desk() {
  let now = noon, requests = 0, saves = 0
  const service = new AmbientService({
    now: () => now,
    config: normalizeAmbient({ enabled: true, displayMinutes: 15, quietStart: 0, quietEnd: 0,
      xEnabled: true, memeEnabled: false, newsEnabled: false, conceptsEnabled: false, promptsEnabled: false,
      petEnabled: false, calendarEnabled: false, accounts: ['Polymarket'], gapMinutes: 30 }),
    status: () => new StatusHub().snapshot(), automaticAllowed: () => true, key: () => 'fixture',
    save: () => { saves++ }, changed() {}, image: async () => '',
    request: async () => {
      requests++
      return { tweets: [1, 2].map(id => ({ id: String(id), author: { userName: 'Polymarket' },
        text: `A substantial desk content fixture number ${id}`, createdAt: new Date(now).toISOString(), likeCount: 9000 })) }
    },
  })
  return { service, requests: () => requests, saves: () => saves, advance: (ms: number) => { now += ms } }
}

test('review 1: status publication ignores timestamps but publishes visible changes', () => {
  let now = 1, lastSeenAt = 0, projected: InkStatusInput['projected'] = {}
  const statuses: InkScreenStatus[] = []
  const runtime = new InkStatusRuntime({ now: () => now, read: () => ({ ...base, lastSeenAt, projected }), publish: status => statuses.push(status) })
  try {
    runtime.refresh()
    for (let i = 0; i < 20; i++) { now += 1000; lastSeenAt = now; runtime.refresh() }
    assert.equal(statuses.length, 1)
    projected = { ambient: { id: 'desk', source: 'Desk', text: 'New content' } }
    runtime.refresh()
    assert.equal(statuses.length, 2)
    assert.equal(statuses[1]!.showing.kind, 'ambient')
  } finally { runtime.stop() }
})

test('review 1: steady long-poll status reads skip projection and publish only connection flips', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let lastSeenAt: number | null = null, reads = 0
  const statuses: InkScreenStatus[] = []
  const runtime = new InkStatusRuntime({ read: () => { reads++; return { ...base, lastSeenAt } }, publish: status => statuses.push(status) })
  try {
    runtime.refresh()
    const onStatusRead = () => { lastSeenAt = Date.now(); runtime.statusRead(lastSeenAt) }
    onStatusRead()
    const connectedReads = reads
    for (let i = 0; i < 100; i++) { context.mock.timers.tick(1000); onStatusRead() }
    assert.equal(reads, connectedReads, 'unchanged authenticated reads must not re-read disk/projection')
    assert.deepEqual(statuses.map(status => status.connection), ['disconnected', 'connected'])
    context.mock.timers.tick(89999)
    assert.equal(statuses.length, 2, 'steady reads extend the current connection deadline')
    context.mock.timers.tick(1)
    assert.equal(statuses.at(-1)?.connection, 'disconnected')
    onStatusRead()
    assert.deepEqual(statuses.map(status => status.connection), ['disconnected', 'connected', 'disconnected', 'connected'])
  } finally { runtime.stop() }
})

test('review 2: apply and setAmbient preserve automatic and fetched cards for non-source changes', async () => {
  const f = desk()
  await f.service.refresh()
  const current = f.service.current(), fetched = f.service.snapshot().cards.filter(card => card.kind === 'x')
  const nextCheckAt = f.service.snapshot().nextCheckAt
  let prepared = 0
  const prepare = f.service.prepareConfiguration.bind(f.service)
  f.service.prepareConfiguration = input => { prepared++; return prepare(input) }
  const shell = new ProductShell(undefined, () => {}, { hudAvailable: () => false, standard() {}, hud() {}, screen() {}, hideStandard() {}, hideHud() {} }, () => {})
  let display = { ...DEFAULT_DEVICE_DISPLAY, agents: [...DEFAULT_DEVICE_DISPLAY.agents] }
  const deps = { shell, ambient: f.service, readDisplay: () => display, writeDisplay: (value: typeof display) => { display = value },
    displaySnapshot: () => ({ config: display, status: toDeviceStatusV1(new StatusHub().snapshot()), serverAvailable: false }), committed() {} }
  applyInk({ plan: DEFAULT_INK_PLAN, display: { ...display, inverted: true } }, deps)
  assert.equal(prepared, 0, 'unchanged derived ambient settings skip the ambient store entirely')
  assert.deepEqual(f.service.current(), current)
  applyInk({ plan: { ...DEFAULT_INK_PLAN, intervalMinutes: 30 }, display }, deps)
  assert.deepEqual(f.service.current(), current, 'dwell changes retain the active card and its deadline')
  const handlers = new Map<string, (...args: any[]) => any>()
  registerAmbientIpc({ handle: (name, action) => { handlers.set(name, action) } }, { service: f.service } as any, () => deps.displaySnapshot().status, async () => {})
  handlers.get('codepulse:ambient-set')!({}, { ...f.service.getConfig(), gapMinutes: 45, dailyLimit: 8, idleOnly: false })
  assert.deepEqual(f.service.current(), current)
  assert.deepEqual(f.service.snapshot().cards.filter(card => card.kind === 'x'), fetched)
  assert.equal(f.service.snapshot().nextCheckAt, nextCheckAt)
  const writes = f.saves()
  f.advance(61000)
  f.service.tick()
  await Promise.resolve()
  assert.equal(f.requests(), 1, 'non-source saves do not trigger another paid collection')
  assert.equal(f.saves(), writes)
})

test('review 2: source changes still invalidate fetched cards and the active automatic card', async () => {
  const f = desk()
  await f.service.refresh()
  f.service.configure({ ...f.service.getConfig(), minLikes: 10000 })
  assert.equal(f.service.current(), undefined)
  assert.equal(f.service.snapshot().cards.filter(card => card.kind === 'x').length, 0)
  assert.equal(f.service.snapshot().nextCheckAt, 0)
})

test('review 3: status callback failures cannot break authenticated normal, conditional or long-poll responses', async () => {
  const server = await startDeviceServer({ hub: new StatusHub(), host: '127.0.0.1', port: 0,
    authToken: 'e'.repeat(32), serverId: 'throwing-read', publishMdns: false,
    onStatusRead: () => { throw new Error('host observer unavailable') } })
  try {
    const headers = { [DEVICE_AUTH_HEADER]: 'e'.repeat(32) }
    const initial = await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH, headers })
    assert.equal(initial.statusCode, 200)
    const conditional = { ...headers, 'if-none-match': initial.headers.etag as string }
    assert.equal((await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH, headers: conditional })).statusCode, 304)
    assert.equal((await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH, headers: { ...conditional, 'x-codepulse-wait-ms': '10' } })).statusCode, 304)
  } finally { await server.close() }
})

test('review 3: a transient projection failure cannot escape refresh or freeze its timer', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let broken = false, reads = 0
  const statuses: InkScreenStatus[] = []
  const runtime = new InkStatusRuntime({ read: () => { reads++; if (broken) throw Error('projection failed'); return { ...base, lastSeenAt: 0 } }, publish: status => statuses.push(status) })
  try {
    runtime.refresh()
    broken = true
    assert.doesNotThrow(() => runtime.refresh())
    const atFailure = reads
    broken = false
    context.mock.timers.tick(1000)
    assert.ok(reads > atFailure, 'a bounded retry is scheduled after failed reads')
    context.mock.timers.tick(89000)
    assert.equal(statuses.at(-1)?.connection, 'disconnected')
  } finally { runtime.stop() }
})

test('review 3: timer advance and publish exceptions recover without escaping the caller', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let advances = 0, publishes = 0
  const runtime = new InkStatusRuntime({ read: () => ({ ...base, lastSeenAt: 0 }),
    publish: () => { if (++publishes === 1) throw Error('closing renderer') },
    advance: () => { if (++advances === 1) throw Error('store unavailable') } })
  try {
    assert.doesNotThrow(() => runtime.refresh())
    assert.doesNotThrow(() => context.mock.timers.tick(1000))
    assert.ok(publishes >= 2)
    assert.doesNotThrow(() => context.mock.timers.tick(89000))
    context.mock.timers.tick(1000)
    assert.ok(advances >= 2, 'advance failures also retain a retry deadline')
  } finally { runtime.stop() }
})

test('review 3: steady device reads cannot postpone a pending projection retry', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let broken = false, reads = 0
  const runtime = new InkStatusRuntime({ read: () => { reads++; if (broken) throw Error('projection'); return { ...base, lastSeenAt: 0 } }, publish() {} })
  try {
    runtime.refresh()
    broken = true
    runtime.refresh()
    const failedReads = reads
    context.mock.timers.tick(500)
    runtime.statusRead(Date.now())
    broken = false
    context.mock.timers.tick(500)
    assert.ok(reads > failedReads, 'the original one-second retry survives connection timer rescheduling')
  } finally { runtime.stop() }
})

test('review 1: authenticated steady long polls publish only connection transitions', async () => {
  let now = 0, reads = 0
  const statuses: InkScreenStatus[] = []
  const runtime = new InkStatusRuntime({ now: () => now, read: () => { reads++; return base }, publish: status => statuses.push(status) })
  runtime.refresh()
  const server = await startDeviceServer({ hub: new StatusHub(), host: '127.0.0.1', port: 0,
    authToken: 'f'.repeat(32), serverId: 'steady-poll', publishMdns: false, onStatusRead: () => runtime.statusRead(now) })
  try {
    const headers = { [DEVICE_AUTH_HEADER]: 'f'.repeat(32) }
    const initial = await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH, headers })
    const connectedReads = reads
    for (let i = 0; i < 4; i++) {
      now += 1000
      const response = await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH,
        headers: { ...headers, 'if-none-match': initial.headers.etag as string, 'x-codepulse-wait-ms': '10' } })
      assert.equal(response.statusCode, 304)
    }
    assert.equal(reads, connectedReads)
    assert.deepEqual(statuses.map(status => status.connection), ['disconnected', 'connected'])
    now += 90000
    runtime.refresh()
    await server.app.inject({ method: 'GET', url: DEVICE_STATUS_PATH, headers })
    assert.deepEqual(statuses.map(status => status.connection), ['disconnected', 'connected', 'disconnected', 'connected'])
  } finally { runtime.stop(); await server.close() }
})

test('review 4: ending temporary ink preserves an automatic card and clears only manual ownership', async () => {
  const f = desk()
  await f.service.refresh()
  const automatic = f.service.current()
  let cleared = 0
  endInkTemporary(f.service, { clearTemporaryInk: () => { cleared++ } })
  assert.deepEqual(f.service.current(), automatic)
  const note = f.service.addPersonal('note', 'temporary')
  f.service.showManual(note.id)
  endInkTemporary(f.service, { clearTemporaryInk: () => { cleared++ } })
  assert.equal(f.service.temporaryInk(), null)
  assert.equal(cleared, 2)
})

test('review 6: simultaneous temporaries follow manual ambient priority regardless of todo deadline', () => {
  const input = { ...base, now: 1, ambientTemporary: { title: 'Picture', until: 10000 }, assistantUntil: 20000 }
  const active = computeInkStatus({ ...input, projected: { ambient: { id: 'manual', source: 'Picture', text: 'Desk note', manual: true } } })
  assert.equal(active.showing.kind, 'ambient')
  assert.equal(active.temporary?.kind, 'ambient')
  assert.equal(computeInkStatus(input).temporary?.kind, 'ambient', 'an alert hides the same manual owner')
  assert.equal(computeInkStatus({ ...input, now: 10000 }).temporary?.kind, 'todos')
})

test('review 8: nextAutoAt is null without eligible fetched content or when every card was seen', async () => {
  const f = desk()
  assert.equal(f.service.nextAutoAt(), null, 'enabled remote categories do not imply an eligible cached card')
  await f.service.refresh()
  assert.notEqual(f.service.nextAutoAt(), null, 'the second fetched card remains eligible')
  f.advance(30 * 60000)
  f.service.show()
  assert.equal(f.service.nextAutoAt(), null, 'daily limits are not the only reason nothing can appear')
})

test('review 8: near-now automatic deadlines do not create millisecond refresh loops', context => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  let reads = 0, advances = 0
  const runtime = new InkStatusRuntime({ read: () => { reads++; return { ...base, nextAutoAt: Date.now() + 1 } },
    publish() {}, advance: () => { advances++ } })
  try {
    runtime.refresh()
    context.mock.timers.tick(5000)
    assert.equal(reads, 1)
    assert.equal(advances, 0)
  } finally { runtime.stop() }
})

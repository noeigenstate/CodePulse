import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DEFAULT_INK_PLAN,
  INK_CONNECTED_WINDOW_MS,
  type DeviceAmbientCard,
} from '@codepulse/shared'
import {
  computeInkStatus,
  InkStatusRuntime,
  type InkStatusInput,
} from '../apps/desktop/src/main/ink-status.js'

const base: InkStatusInput = {
  plan: { ...DEFAULT_INK_PLAN, items: ['work', 'ambient', 'todos'], intervalMinutes: 5 },
  now: 0,
  lastSeenAt: 0,
  serverEnabled: true,
  projected: {},
  ambientTemporary: null,
  assistantUntil: 0,
  ambientPausedReason: '',
}
const card: DeviceAmbientCard = { id: 'card', source: '概念卡 · 机会成本', text: '定义' }

test('ink status uses the same wall-clock slots and next boundary as the device', () => {
  for (const [now, current, next] of [
    [0, 'work', 'ambient'],
    [300000, 'ambient', 'todos'],
    [899999, 'todos', 'work'],
    [900000, 'work', 'ambient'],
  ] as const) {
    const status = computeInkStatus({ ...base, now })
    assert.equal(status.current, current)
    assert.deepEqual(status.next, { feature: next, at: (Math.floor(now / 300000) + 1) * 300000 })
  }
})
test('fixed work and one-item cycles have no next slot', () => {
  const fixed = computeInkStatus({ ...base, plan: { ...base.plan, mode: 'single' } })
  assert.equal(fixed.current, 'work')
  assert.equal(fixed.mode, 'single')
  assert.equal(fixed.next, null)
  assert.equal(computeInkStatus({ ...base, plan: { ...base.plan, items: ['work'] } }).next, null)
})
test('showing follows the final projection, including empty todo lists', () => {
  assert.deepEqual(computeInkStatus({ ...base, projected: { ambient: card } }).showing, {
    kind: 'ambient',
    title: `${card.source} · ${card.text}`,
    id: 'card',
  })
  assert.equal(
    computeInkStatus({ ...base, projected: { ambient: { ...card, items: [] } } }).showing.kind,
    'todos',
  )
  const fallback = computeInkStatus({
    ...base,
    now: 300000,
    ambientPausedReason: '今日展示已达上限',
  })
  assert.equal(fallback.showing.kind, 'work')
  assert.equal(fallback.slotNote, '桌边内容时段：今日展示已达上限，暂显示工作画面')
})
for (const kind of ['ambient', 'todos'] as const) {
  test(`${kind} temporary state remains while hidden and disappears at its original expiry`, () => {
    const input = {
      ...base,
      now: 100,
      ambientTemporary: kind === 'ambient' ? { title: '概念卡', until: 600000 } : null,
      assistantUntil: kind === 'todos' ? 600000 : 0,
    }
    const active = computeInkStatus({
      ...input,
      projected: { ambient: { ...card, manual: true, ...(kind === 'todos' ? { items: [] } : {}) } },
    })
    assert.equal(active.temporary?.kind, kind)
    assert.equal(active.showing.kind, kind)
    assert.equal(active.slotNote, '')
    const hidden = computeInkStatus(input)
    assert.equal(hidden.temporary?.until, 600000)
    assert.equal(hidden.showing.kind, 'work')
    assert.equal(hidden.slotNote, '授权或异常提醒优先，临时展示暂停')
    const expired = computeInkStatus({ ...input, now: 600000 })
    assert.equal(expired.temporary, null)
  })
}
test('connection expires exactly at 90 seconds; no read and future timestamps are disconnected', () => {
  assert.equal(
    computeInkStatus({ ...base, now: INK_CONNECTED_WINDOW_MS - 1 }).connection,
    'connected',
  )
  assert.equal(
    computeInkStatus({ ...base, now: INK_CONNECTED_WINDOW_MS }).connection,
    'disconnected',
  )
  assert.equal(computeInkStatus({ ...base, lastSeenAt: null }).connection, 'disconnected')
  assert.equal(computeInkStatus({ ...base, lastSeenAt: 1 }).connection, 'disconnected')
  assert.equal(computeInkStatus({ ...base, serverEnabled: false }).connection, 'server-off')
})
test('one status timer wakes at connection expiry, temporary expiry and slot boundaries', (context) => {
  context.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 })
  const statuses: ReturnType<typeof computeInkStatus>[] = []
  let advances = 0
  const runtime = new InkStatusRuntime({
    read: () => ({ ...base, assistantUntil: 120000 }),
    publish: (status) => statuses.push(status),
    advance: () => advances++,
  })
  runtime.refresh()
  context.mock.timers.tick(90000)
  assert.equal(statuses.at(-1)?.connection, 'disconnected')
  context.mock.timers.tick(30000)
  assert.equal(statuses.at(-1)?.temporary, null)
  context.mock.timers.tick(180000)
  assert.equal(statuses.at(-1)?.current, 'ambient')
  assert.equal(advances, 3)
  runtime.stop()
  context.mock.timers.tick(300000)
  assert.equal(advances, 3)
})
test('showing carries the projected card id for ambient and todo cards, and none for the work screen', () => {
  assert.equal(
    computeInkStatus({ ...base, projected: { ambient: card } }).showing.kind === 'ambient' &&
      (computeInkStatus({ ...base, projected: { ambient: card } }).showing as { id?: string }).id,
    'card',
  )
  const todos = computeInkStatus({
    ...base,
    projected: { ambient: { ...card, id: 'todo-card', items: [] } },
  }).showing as { kind: string; id?: string }
  assert.deepEqual([todos.kind, todos.id], ['todos', 'todo-card'])
  assert.deepEqual(computeInkStatus({ ...base }).showing, { kind: 'work' })
})

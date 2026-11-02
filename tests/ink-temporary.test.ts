import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_INK_PLAN, type StatusSnapshot, type InkDisplayPlan } from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { LumaAssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { endInkTemporary } from '../apps/desktop/src/main/ink-apply.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'
import { inkFeatureAt } from '../apps/desktop/src/main/ambient-plan.js'

const noon = new Date(2026, 10, 2, 12).getTime()
function fixture(options: { config?: object; history?: object; plan?: InkDisplayPlan } = {}) {
  let now = noon
  let status: StatusSnapshot = new StatusHub().snapshot()
  const plan = options.plan ?? { ...DEFAULT_INK_PLAN, intervalMinutes: 5 as const }
  const service = new AmbientService({
    config: { enabled: true, idleOnly: true, quietStart: 0, quietEnd: 0, ...options.config },
    history: options.history as any,
    now: () => now,
    plan: () => plan,
    automaticAllowed: () => inkFeatureAt(plan, now) === 'ambient',
    status: () => status,
    key: () => '',
    save() {},
    changed() {},
    request: async () => ({}),
    image: async () => '',
  })
  const state = (state: string) => {
    status = {
      ...new StatusHub().snapshot(),
      agents: [{ agentType: 'codex', state, unread: false }],
    } as StatusSnapshot
  }
  return {
    service,
    plan,
    state,
    now: () => now,
    setNow: (time: number) => {
      now = time
    },
  }
}
test('manual ambient is ten minutes regardless of auto dwell and resumes after urgent alerts', () => {
  const f = fixture({ config: { displayMinutes: 30, enabled: false } })
  const card = f.service.addPersonal('note', '临时内容')
  f.service.showManual(card.id)
  assert.equal(f.service.temporaryInk()?.until, noon + 600000)
  f.state('WAITING_PERMISSION')
  f.service.tick()
  assert.equal(f.service.current(), undefined)
  assert.equal(f.service.temporaryInk()?.until, noon + 600000)
  f.setNow(noon + 599999)
  f.state('IDLE')
  f.service.tick()
  assert.equal(f.service.current()?.id, card.id)
  f.setNow(noon + 600000)
  assert.equal(f.service.current(), undefined)
  f.service.tick()
  assert.equal(f.service.temporaryInk(), null)
})
test('todo temporary is ten minutes, survives alerts without extension and ending preserves the plan', () => {
  const f = fixture()
  const store = new AssistantStore(':memory:')
  const keys = { llmKey: '', speechAppKey: '', speechToken: '' }
  const assistant = new AssistantService({
    store,
    now: f.now,
    provider: new LumaAssistantProvider(() => keys),
    keys: () => keys,
    save() {},
    changed() {},
    notify: () => false,
    automaticAllowed: () => false,
  })
  try {
    assistant.showOnInk()
    assert.equal(assistant.temporaryInkUntil(), noon + 600000)
    const urgent = {
      agents: [{ agentType: 'codex', state: 'WAITING_PERMISSION' }],
    } as StatusSnapshot
    assert.equal(assistant.inkCard(urgent), undefined)
    assert.equal(assistant.temporaryInkUntil(), noon + 600000)
    f.setNow(noon + 599999)
    assert.equal(assistant.inkCard({ agents: [] })?.manual, true)
    f.setNow(noon + 600000)
    assert.equal(assistant.inkCard({ agents: [] }), undefined)
    assert.equal(assistant.temporaryInkUntil(), 0)
    assistant.showOnInk()
    assistant.hideOnInk()
    assert.equal(assistant.temporaryInkUntil(), 0)
    assistant.showOnInk()
    const card = f.service.addPersonal('note', '临时便签')
    f.service.showManual(card.id)
    const before = structuredClone(f.plan)
    endInkTemporary(f.service, assistant)
    assert.equal(assistant.temporaryInkUntil(), 0)
    assert.equal(f.service.temporaryInk(), null)
    assert.deepEqual(f.plan, before)
  } finally {
    store.close()
  }
})
test('renderer rule saves retain the plan-derived enabled and dwell values', () => {
  const f = fixture({ config: { enabled: true, displayMinutes: 30 } })
  const handlers = new Map<string, (...args: any[]) => any>()
  registerAmbientIpc(
    {
      handle: (channel, callback) => {
        handlers.set(channel, callback)
      },
    },
    { service: f.service } as any,
    () => ({}) as any,
    async () => {},
  )
  handlers.get('codepulse:ambient-set')!(
    {},
    { ...f.service.getConfig(), enabled: false, displayMinutes: 1, gapMinutes: 45 },
  )
  assert.equal(f.service.getConfig().enabled, true)
  assert.equal(f.service.getConfig().displayMinutes, 30)
  assert.equal(f.service.getConfig().gapMinutes, 45)
})
test('nextAutoAt respects gaps and future playlist slots, independently of nextCheckAt', () => {
  const f = fixture({
    history: { day: '2026-11-2', shown: 1, lastShown: noon - 20 * 60000, seen: {} },
    config: { gapMinutes: 30 },
  })
  assert.equal(f.service.snapshot().nextCheckAt, 0)
  assert.equal(f.service.snapshot().nextAutoAt, noon + 15 * 60000)
})
test('nextAutoAt respects quiet hours and returns null when nothing is eligible today', () => {
  const quiet = fixture({ config: { quietStart: 12, quietEnd: 13 } })
  assert.equal(quiet.service.nextAutoAt(), noon + 65 * 60000)
  const capped = fixture({ history: { day: '2026-11-2', shown: 6, lastShown: noon, seen: {} } })
  assert.equal(capped.service.nextAutoAt(), null)
  const disabled = fixture({ plan: { ...DEFAULT_INK_PLAN, mode: 'single' } })
  assert.equal(disabled.service.nextAutoAt(), null)
  const busy = fixture()
  busy.state('THINKING')
  assert.equal(busy.service.nextAutoAt(), null)
  busy.state('WAITING_PERMISSION')
  assert.equal(busy.service.nextAutoAt(), null)
  quiet.setNow(new Date(2026, 10, 2, 23, 30).getTime())
  quiet.service.configure({ ...quiet.service.getConfig(), quietStart: 23, quietEnd: 8 })
  assert.equal(quiet.service.nextAutoAt(), null)
})

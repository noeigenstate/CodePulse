import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import {
  LumaAssistantProvider,
  parseAssistantPlan,
} from '../apps/desktop/src/main/assistant-provider.js'
import { resolveReminderTime } from '../apps/desktop/src/main/assistant-time.js'
import { DEFAULT_ASSISTANT_SETTINGS } from '@codepulse/shared'

function fixture() {
  let now = new Date(2026, 9, 29, 12, 0).getTime(),
    notifications = 0
  const store = new AssistantStore(':memory:'),
    keys = { llmKey: '', speechAppKey: '', speechToken: '' }
  const provider = new LumaAssistantProvider(() => keys)
  const service = new AssistantService({
    store,
    provider,
    keys: () => keys,
    now: () => now,
    save: () => {},
    changed: () => {},
    notify: () => {
      notifications++
      return true
    },
    settings: { ...DEFAULT_ASSISTANT_SETTINGS, quietStart: 0, quietEnd: 0 },
  })
  return {
    store,
    service,
    setNow: (v: number) => {
      now = v
    },
    get now() {
      return now
    },
    get notifications() {
      return notifications
    },
  }
}
test('pending tasks survive reopen and are separate from other product data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codepulse-assistant-')),
    path = join(dir, 'assistant.sqlite')
  try {
    const first = new AssistantStore(path),
      task = first.add({ title: '备课', notes: '一段备注' })
    first.close()
    const second = new AssistantStore(path)
    assert.equal(second.get(task.id)?.title, '备课')
    assert.equal(second.list().length, 1)
    second.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('invalid dates and invalid lengths never enter the store', () => {
  const f = fixture()
  try {
    assert.throws(() => f.service.add({ title: '过去的提醒', dueAt: f.now - 1 }))
    assert.throws(() => f.service.add({ title: 'x'.repeat(161) }))
    assert.equal(f.store.list().length, 0)
  } finally {
    f.store.close()
  }
})
test('local natural reminders are drafts until confirmed and apply idempotently', async () => {
  const f = fixture()
  try {
    const draft = await f.service.interpret('10分钟后提醒我喝水')
    assert.equal(f.store.list().length, 0)
    assert.equal(draft.tasks[0].dueAt, f.now + 600000)
    f.service.apply(draft.id)
    f.service.apply(draft.id)
    assert.equal(f.store.list().length, 1)
    assert.equal(f.store.list()[0].title, '喝水')
  } finally {
    f.store.close()
  }
})
test('draft expiry prevents late, unintended reminder creation', async () => {
  const f = fixture()
  try {
    const draft = await f.service.interpret('10分钟后提醒我喝水')
    f.setNow(f.now + 600001)
    assert.throws(() => f.service.apply(draft.id))
    assert.equal(f.store.list().length, 0)
  } finally {
    f.store.close()
  }
})
test('reminder delivery is once, snoozing schedules a fresh reminder, overdue tasks remain visible', () => {
  const f = fixture()
  try {
    const task = f.store.add({ title: '喝水', dueAt: f.now + 1000 }, f.now)
    f.setNow(f.now + 1001)
    f.service.tick()
    f.service.tick()
    assert.equal(f.notifications, 1)
    f.service.snooze(task.id, 600)
    f.setNow(f.now + 600001)
    f.service.tick()
    assert.equal(f.notifications, 2)
    const missed = f.store.add({ title: '错过的提醒', dueAt: f.now + 1000 }, f.now)
    f.setNow(f.now + 1801001)
    f.service.tick()
    assert.equal(f.store.get(missed.id)?.reminderState, 'expired')
    assert.equal(f.store.get(missed.id)?.status, 'pending')
    assert.equal(f.notifications, 2)
  } finally {
    f.store.close()
  }
})
test('quiet hours do not mark a reminder delivered or ring after the catch-up window', () => {
  const f = fixture()
  try {
    f.service.configure({ ...DEFAULT_ASSISTANT_SETTINGS, quietStart: 0, quietEnd: 23 })
    const task = f.store.add({ title: '安静提醒', dueAt: f.now + 1000 }, f.now)
    f.setNow(f.now + 1001)
    f.service.tick()
    assert.equal(f.notifications, 0)
    assert.equal(f.store.get(task.id)?.reminderState, 'pending')
    f.setNow(f.now + 1800001)
    f.service.tick()
    assert.equal(f.notifications, 0)
    assert.equal(f.store.get(task.id)?.reminderState, 'expired')
  } finally {
    f.store.close()
  }
})
test('an invalid multi-action plan rolls back all task changes', async () => {
  const f = fixture()
  try {
    const service = new AssistantService({
      store: f.store,
      keys: () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
      changed: () => {},
      notify: () => true,
      save: () => {},
      now: () => f.now,
      provider: {
        plan: async () => ({
          reply: '确认',
          actions: [
            { kind: 'create_task', title: '第一项' },
            { kind: 'create_task', title: '第二项', secondsFromNow: 1 },
          ],
        }),
        transcribe: async () => '',
        synthesize: async () => new Uint8Array(),
      },
    })
    const draft = await service.interpret('创建两项')
    f.setNow(f.now + 2000)
    assert.throws(() => service.apply(draft.id))
    assert.equal(f.store.list().length, 0)
  } finally {
    f.store.close()
  }
})
test('host resolves calendar times and rejects impossible or mixed dates', () => {
  const now = new Date(2026, 9, 29, 12, 0).getTime()
  assert.equal(resolveReminderTime({ secondsFromNow: 60 }, now), now + 60000)
  assert.throws(() => resolveReminderTime({ localDate: '2026-02-30', localTime: '12:00' }, now))
  assert.throws(() => resolveReminderTime({ secondsFromNow: 60, localDate: '2026-10-30' }, now))
})
test('untrusted AI actions are validated; invented function names are not executed', () => {
  assert.throws(() =>
    parseAssistantPlan(
      JSON.stringify({ reply: '执行', actions: [{ kind: 'run_shell', command: 'anything' }] }),
    ),
  )
  assert.throws(() =>
    parseAssistantPlan(
      JSON.stringify({
        reply: '执行',
        actions: [{ kind: 'snooze_task', id: 'x', secondsFromNow: -1 }],
      }),
    ),
  )
  assert.equal(parseAssistantPlan('```json\n{"reply":"你好","actions":[]}\n```').reply, '你好')
})
test('provider bounds responses and does not expose a provider error body', async () => {
  const provider = new LumaAssistantProvider(
    () => ({ llmKey: 'test-key-not-real', speechAppKey: '', speechToken: '' }),
    async () => new Response('private-provider-response', { status: 401 }),
  )
  await assert.rejects(
    () => provider.plan('问题', DEFAULT_ASSISTANT_SETTINGS, [], [], Date.now()),
    (error) => error instanceof Error && !error.message.includes('private-provider-response'),
  )
})
test('audio is opt-in and never sends data when disabled', async () => {
  const f = fixture()
  try {
    await assert.rejects(() => f.service.listen(new Uint8Array(3200)), /开启语音输入/)
    await assert.rejects(() => f.service.speak('你好'), /开启语音输出/)
  } finally {
    f.store.close()
  }
})

test('voice-only reminders and device receipts survive a service restart', () => {
  const f = fixture(),
    settings = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      notifications: false,
      voiceOutput: true,
      quietStart: 0,
      quietEnd: 0,
    }
  const create = () =>
    new AssistantService({
      store: f.store,
      keys: () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
      provider: new LumaAssistantProvider(() => ({
        llmKey: '',
        speechAppKey: '',
        speechToken: '',
      })),
      changed: () => {},
      save: () => {},
      notify: () => {
        throw Error('Desktop notification must stay disabled')
      },
      now: () => f.now,
      settings,
    })
  try {
    const task = f.store.add({ title: '设备播报', dueAt: f.now + 1000 }, f.now),
      first = create()
    f.setNow(f.now + 1001)
    first.tick()
    const message = first.claimAnnouncement('device-one')
    assert.ok(message)
    first.acknowledgeAnnouncement('device-one', message.id)
    first.stop()
    assert.equal(f.store.get(task.id)?.reminderState, 'delivered')
    const second = create()
    assert.equal(second.claimAnnouncement('device-one'), null)
    assert.equal(second.claimAnnouncement('device-two')?.id, message.id)
    second.stop()
  } finally {
    f.store.close()
  }
})
test('task cancellation does not discard another task announcement', () => {
  const f = fixture()
  try {
    f.service.configure({
      ...DEFAULT_ASSISTANT_SETTINGS,
      notifications: false,
      voiceOutput: true,
      quietStart: 0,
      quietEnd: 0,
    })
    const a = f.store.add({ title: '第一项', dueAt: f.now + 1000 }, f.now),
      b = f.store.add({ title: '第二项', dueAt: f.now + 1000 }, f.now)
    f.setNow(f.now + 1001)
    f.service.tick()
    f.service.finish(a.id, true)
    assert.equal(f.service.claimAnnouncement('device')?.text, b.title)
  } finally {
    f.store.close()
  }
})
test('settings and task writes share an atomic database transaction', () => {
  const f = fixture()
  try {
    assert.throws(() =>
      f.store.transaction(() => {
        f.store.add({ title: '不能留下' }, f.now)
        f.store.saveSettings(DEFAULT_ASSISTANT_SETTINGS)
        throw Error('simulated failure')
      }),
    )
    assert.equal(f.store.list().length, 0)
    assert.equal(f.store.settings(), undefined)
  } finally {
    f.store.close()
  }
})
test('AI keys are selected by provider and never reused across providers', async () => {
  const calls: { url: string; authorization: string | null }[] = []
  const provider = new LumaAssistantProvider(
    () => ({
      llmKey: '',
      llmKeys: { glm: 'fixture-glm-key', tongyi: 'fixture-tongyi-key' },
      speechAppKey: '',
      speechToken: '',
    }),
    async (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('Authorization'),
      })
      return Response.json({
        choices: [{ message: { content: JSON.stringify({ reply: '测试响应', actions: [] }) } }],
      })
    },
  )
  await provider.plan(
    '测试',
    { ...DEFAULT_ASSISTANT_SETTINGS, provider: 'glm' },
    [],
    [],
    Date.now(),
  )
  await provider.plan(
    '测试',
    { ...DEFAULT_ASSISTANT_SETTINGS, provider: 'tongyi', model: 'qwen-plus' },
    [],
    [],
    Date.now(),
  )
  assert.equal(calls[0].authorization, 'Bearer fixture-glm-key')
  assert.match(calls[0].url, /bigmodel.cn/)
  assert.equal(calls[1].authorization, 'Bearer fixture-tongyi-key')
  assert.match(calls[1].url, /dashscope.aliyuncs.com/)
})
test('todo pages are stable between deadline milestones, without countdown refreshes', () => {
  const f = fixture()
  try {
    f.store.add({ title: '稳定待办', dueAt: f.now + 600000 }, f.now)
    f.service.showOnInk()
    const first = f.service.inkCard({ agents: [] })
    assert.equal(first?.items?.length, 1)
    f.setNow(f.now + 60000)
    assert.equal(f.service.inkCard({ agents: [] })?.id, first?.id)
    f.setNow(f.now + 540001)
    const overdue = f.service.inkCard({ agents: [] })
    assert.notEqual(overdue?.id, first?.id)
    assert.equal(overdue?.items?.[0].overdue, true)
  } finally {
    f.store.close()
  }
})

test('editing an overdue title preserves its delivery receipt instead of ringing again', () => {
  const f = fixture()
  try {
    const task = f.store.add({ title: '旧标题', dueAt: f.now + 1000 }, f.now)
    f.setNow(f.now + 1001)
    f.service.tick()
    f.service.update(task.id, { title: '更新后的标题', dueAt: task.dueAt })
    f.service.tick()
    assert.equal(f.store.get(task.id)?.title, '更新后的标题')
    assert.equal(f.store.get(task.id)?.reminderState, 'delivered')
    assert.equal(f.notifications, 1)
  } finally {
    f.store.close()
  }
})

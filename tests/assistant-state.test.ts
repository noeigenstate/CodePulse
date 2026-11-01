import test from 'node:test'
import assert from 'node:assert/strict'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import type { AssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { DEFAULT_ASSISTANT_SETTINGS } from '@codepulse/shared'

function create(store: AssistantStore, provider: AssistantProvider, now: number) {
  return new AssistantService({
    store,
    provider,
    keys: () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
    save: () => {},
    changed: () => {},
    notify: () => true,
    now: () => now,
  })
}
test('stale AI completion cannot modify a task edited in another window', async () => {
  const store = new AssistantStore(':memory:'),
    now = Date.now()
  try {
    const task = store.add({ title: '原来的事项' }, now)
    const service = create(
      store,
      {
        plan: async () => ({
          reply: '确认完成',
          actions: [{ kind: 'complete_task', id: task.id }],
        }),
        transcribe: async () => '',
        synthesize: async () => new Uint8Array(),
      },
      now,
    )
    const draft = await service.interpret('完成这件事')
    store.update(task.id, { title: '已经改过的事项' }, now)
    assert.throws(() => service.apply(draft.id), /已变化/)
    assert.equal(store.get(task.id)?.status, 'pending')
  } finally {
    store.close()
  }
})
test('follow-up context is bounded and isolated for each voice device', async () => {
  const store = new AssistantStore(':memory:'),
    histories: number[] = []
  try {
    const service = create(
      store,
      {
        plan: async (_input, _settings, _tasks, _memories, _now, history) => {
          histories.push(history?.length ?? 0)
          return { reply: '请补充时间', actions: [] }
        },
        transcribe: async () => '',
        synthesize: async () => new Uint8Array(),
      },
      Date.now(),
    )
    await service.interpret('提醒我喝水', 'device-one')
    await service.interpret('十分钟后', 'device-one')
    await service.interpret('你好', 'device-two')
    assert.deepEqual(histories, [0, 2, 0])
    service.stop()
  } finally {
    store.close()
  }
})

test('recent reminder follows the receiving device and expires after ten minutes', async () => {
  const store = new AssistantStore(':memory:')
  let now = new Date(2026, 9, 29, 12).getTime()
  const recent: (string | null)[] = []
  const service = new AssistantService({
    store,
    keys: () => ({ llmKey: '', speechAppKey: '', speechToken: '' }),
    save: () => {},
    changed: () => {},
    notify: () => false,
    now: () => now,
    settings: {
      ...DEFAULT_ASSISTANT_SETTINGS,
      notifications: false,
      voiceOutput: true,
      quietStart: 0,
      quietEnd: 0,
    },
    provider: {
      plan: async (_a, _b, _c, _d, _e, _f, context) => {
        recent.push(context?.recentReminder?.id ?? null)
        return { reply: '请确认', actions: [] }
      },
      transcribe: async () => '',
      synthesize: async () => new Uint8Array(),
    },
  })
  try {
    const task = store.add({ title: '喝水', dueAt: now + 1000 }, now)
    now += 1001
    service.tick()
    const announcement = service.claimAnnouncement('one')!
    service.acknowledgeAnnouncement('one', announcement.id)
    await service.interpret('稍后提醒', 'one')
    await service.interpret('稍后提醒', 'two')
    now += 600001
    await service.interpret('稍后提醒', 'one')
    assert.deepEqual(recent, [task.id, null, null])
  } finally {
    service.stop()
    store.close()
  }
})

test('turning speech off while synthesis is pending cancels audio delivery', async () => {
  const store = new AssistantStore(':memory:')
  let finish!: (pcm: Uint8Array) => void
  const service = create(
    store,
    {
      plan: async () => ({ reply: '你好', actions: [] }),
      transcribe: async () => '',
      synthesize: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    },
    new Date(2026, 9, 29, 12).getTime(),
  )
  try {
    service.configure({
      ...DEFAULT_ASSISTANT_SETTINGS,
      voiceOutput: true,
      quietStart: 0,
      quietEnd: 0,
    })
    const pending = service.speak('你好')
    await assert.rejects(() => service.speak('第二条'), /正在处理/)
    service.configure({ ...DEFAULT_ASSISTANT_SETTINGS, voiceOutput: false })
    finish(new Uint8Array([0, 0]))
    await assert.rejects(() => pending, /已取消/)
  } finally {
    service.stop()
    store.close()
  }
})

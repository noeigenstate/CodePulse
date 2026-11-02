import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InkDisplayPlan, InkScreenStatus } from '@codepulse/shared'
import { clockText, inkPillText, inkPlanChip } from '../apps/desktop/src/renderer/src/lib/inkStatusText.js'

const NOW = new Date(2026, 10, 2, 14, 18, 0).getTime()
const base: InkScreenStatus = {
  connection: 'connected',
  lastSeenAt: NOW - 5000,
  showing: { kind: 'work' },
  temporary: null,
  mode: 'cycle',
  current: 'work',
  next: null,
  slotNote: '',
  updatedAt: NOW,
}
const make = (patch: Partial<InkScreenStatus>): InkScreenStatus => ({ ...base, ...patch })

test('server-off: hollow dot, short label, and the env-var hint carried by the info mark', () => {
  const pill = inkPillText(make({ connection: 'server-off', lastSeenAt: null }), NOW, 'zh')
  assert.equal(pill.state, 'server-off')
  assert.equal(pill.dot, 'hollow')
  assert.equal(pill.prefix, '墨水屏')
  assert.equal(pill.label, '服务未开启')
  assert.equal(pill.info, '启动时设置 CODEPULSE_DEVICE_SERVER_ENABLED=1')
  assert.match(pill.title, /服务未开启/)
  assert.equal(pill.canEnd, false)
})

test('disconnected: hollow dot, 未连接, no info mark and no end button', () => {
  const pill = inkPillText(make({ connection: 'disconnected', lastSeenAt: null }), NOW, 'zh')
  assert.equal(pill.state, 'disconnected')
  assert.equal(pill.dot, 'hollow')
  assert.equal(`${pill.prefix} ${pill.label}`, '墨水屏 未连接')
  assert.equal(pill.info, '')
  assert.equal(pill.canEnd, false)
})

test('connected with a next slot: current screen, clock time and next feature', () => {
  const at = NOW + 12 * 60000
  const pill = inkPillText(make({ next: { feature: 'ambient', at } }), NOW, 'zh')
  assert.equal(pill.state, 'connected')
  assert.equal(pill.dot, 'filled')
  assert.equal(pill.label, '工作画面 · 14:30 桌边内容')
  assert.equal(clockText(at), '14:30')
  assert.match(pill.title, /正在显示：工作画面/)
  assert.match(pill.title, /下一项：桌边内容 14:30（12 分钟后）/)
})

test('connected in fixed mode reads 固定 · 工作画面, with one slot 仅工作画面', () => {
  assert.equal(inkPillText(make({ mode: 'single' }), NOW, 'zh').label, '固定 · 工作画面')
  assert.equal(inkPillText(make({ mode: 'cycle', next: null }), NOW, 'zh').label, '仅工作画面')
})

test('connected names a desk card or the todo list as the current screen', () => {
  const at = NOW + 60000
  const card = inkPillText(make({ showing: { kind: 'ambient', title: '机会成本' }, next: { feature: 'work', at } }), NOW, 'zh')
  assert.equal(card.label, `桌边内容 · ${clockText(at)} 工作画面`)
  assert.match(card.title, /桌边内容 · 机会成本/)
  const todos = inkPillText(make({ showing: { kind: 'todos', title: '待办' }, next: { feature: 'work', at } }), NOW, 'zh')
  assert.equal(todos.label, `待办 · ${clockText(at)} 工作画面`)
})

test('temporary display: ring dot, minutes left, the cross ends it', () => {
  const until = NOW + 7 * 60000 + 1
  const pill = inkPillText(
    make({ showing: { kind: 'ambient', title: '机会成本' }, temporary: { kind: 'ambient', title: '机会成本', until } }),
    NOW,
    'zh',
  )
  assert.equal(pill.state, 'temporary')
  assert.equal(pill.dot, 'ring')
  assert.equal(`${pill.prefix} ${pill.label}`, '临时展示 剩 8 分钟')
  assert.match(pill.title, /机会成本/)
  assert.equal(pill.canEnd, true)
})

test('a temporary display hidden by an alert is marked paused, keeps counting and shows the note in the title', () => {
  const note = '授权或异常提醒优先，临时展示暂停'
  const pill = inkPillText(
    make({ showing: { kind: 'work' }, temporary: { kind: 'todos', title: '待办', until: NOW + 3 * 60000 }, slotNote: note }),
    NOW,
    'zh',
  )
  assert.equal(pill.label, '已暂停 · 剩 3 分钟')
  assert.ok(pill.title.endsWith(note))
  assert.equal(pill.canEnd, true)
})

test('slotNote joins the title of a connected pill and never a stopped service', () => {
  const note = '桌边内容时段：今日展示已达上限，暂显示工作画面'
  assert.ok(inkPillText(make({ slotNote: note }), NOW, 'zh').title.endsWith(note))
  assert.ok(!inkPillText(make({ connection: 'server-off', slotNote: note }), NOW, 'zh').title.includes(note))
})

test('a whitespace-only slotNote adds nothing to the title', () => {
  const plain = inkPillText(make({}), NOW, 'zh').title
  assert.equal(inkPillText(make({ slotNote: '   ' }), NOW, 'zh').title, plain)
  assert.ok(!plain.endsWith(' · '))
})

test('minutes never go negative once a deadline has passed', () => {
  const pill = inkPillText(
    make({ showing: { kind: 'ambient', title: 'x' }, temporary: { kind: 'ambient', title: 'x', until: NOW - 1000 } }),
    NOW,
    'zh',
  )
  assert.equal(pill.label, '剩 0 分钟')
})

test('English wording mirrors every state', () => {
  assert.equal(inkPillText(make({ connection: 'server-off' }), NOW, 'en').label, 'service off')
  assert.equal(inkPillText(make({ connection: 'disconnected' }), NOW, 'en').label, 'not connected')
  const next = inkPillText(make({ next: { feature: 'todos', at: NOW + 60000 } }), NOW, 'en')
  assert.match(next.label, /^Work · \d\d:\d\d Tasks$/)
  assert.equal(inkPillText(make({ mode: 'single' }), NOW, 'en').label, 'Fixed · Work')
  const temp = inkPillText(make({ showing: { kind: 'ambient', title: 'Card' }, temporary: { kind: 'ambient', title: 'Card', until: NOW + 120000 } }), NOW, 'en')
  assert.equal(`${temp.prefix} ${temp.label}`, 'Temporary 2 min left')
})

const plan = (patch: Partial<InkDisplayPlan>): InkDisplayPlan => ({ mode: 'cycle', fixed: 'work', items: ['work', 'ambient'], intervalMinutes: 15, ...patch })

test('plan chip reflects the applied playlist and adds the connect note offline', () => {
  assert.deepEqual(inkPlanChip(plan({}), 'ambient', 'connected', 'zh'), { included: true, text: '轮播中 · 每 15 分钟' })
  assert.deepEqual(inkPlanChip(plan({}), 'ambient', 'disconnected', 'zh'), { included: true, text: '轮播中 · 每 15 分钟（连接后生效）' })
  assert.deepEqual(inkPlanChip(plan({}), 'todos', 'connected', 'zh'), { included: false, text: '未加入节目单' })
  assert.equal(inkPlanChip(plan({ mode: 'single' }), 'ambient', 'connected', 'zh').text, '只显示工作画面')
  assert.equal(inkPlanChip(plan({ mode: 'single' }), 'todos', 'server-off', 'zh').text, '只显示工作画面（连接后生效）')
  assert.match(inkPlanChip(plan({ items: ['work', 'todos'], intervalMinutes: 10 }), 'todos', undefined, 'en').text, /^Rotating · every 10 min/)
})

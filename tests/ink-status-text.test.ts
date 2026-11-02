import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { InkDisplayPlan, InkScreenStatus } from '@codepulse/shared'
import { clockText, inkPlanChip, inkStatusText } from '../apps/desktop/src/renderer/src/lib/inkStatusText.js'

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

test('server-off shows a hollow dot, the env hint and no button', () => {
  const text = inkStatusText(make({ connection: 'server-off', lastSeenAt: null }), NOW, 'zh')
  assert.equal(text.state, 'server-off')
  assert.equal(text.dot, 'hollow')
  assert.equal(text.headline, '墨水屏 · 设备服务未开启')
  assert.deepEqual(text.messages, ['启动时设置 CODEPULSE_DEVICE_SERVER_ENABLED=1'])
  assert.equal(text.action, null)
})

test('disconnected offers the connect button and explains that previews sync later', () => {
  const text = inkStatusText(make({ connection: 'disconnected', lastSeenAt: null }), NOW, 'zh')
  assert.equal(text.state, 'disconnected')
  assert.equal(text.dot, 'hollow')
  assert.equal(text.headline, '墨水屏 · 未连接')
  assert.deepEqual(text.messages, ['可先用预览配置，连接后自动同步'])
  assert.equal(text.action, 'connect')
  assert.equal(text.actionLabel, '连接设备')
})

test('connected shows what is on screen and the next slot with its clock time and minutes', () => {
  const at = NOW + 12 * 60000
  const text = inkStatusText(make({ next: { feature: 'ambient', at } }), NOW, 'zh')
  assert.equal(text.state, 'connected')
  assert.equal(text.dot, 'filled')
  assert.equal(text.headline, '墨水屏 · 已连接')
  assert.equal(text.messages[0], '正在显示：工作画面')
  assert.equal(text.messages[1], `下一项：桌边内容 · ${clockText(at)}（12 分钟后）`)
  assert.equal(clockText(at), '14:30')
  assert.equal(text.action, 'playlist')
  assert.equal(text.actionLabel, '节目单')
})

test('connected in fixed mode says fixed work screen, with one slot says work only', () => {
  const fixed = inkStatusText(make({ mode: 'single' }), NOW, 'zh')
  assert.deepEqual(fixed.messages, ['正在显示：工作画面', '固定显示：工作画面'])
  const only = inkStatusText(make({ mode: 'cycle', next: null }), NOW, 'zh')
  assert.deepEqual(only.messages, ['正在显示：工作画面', '仅工作画面'])
})

test('connected names the desk card and the todo list on screen', () => {
  const card = inkStatusText(make({ showing: { kind: 'ambient', title: '机会成本' }, current: 'ambient' }), NOW, 'zh')
  assert.equal(card.messages[0], '正在显示：桌边内容 · 机会成本')
  const todos = inkStatusText(make({ showing: { kind: 'todos', title: '待办' }, current: 'todos' }), NOW, 'zh')
  assert.equal(todos.messages[0], '正在显示：待办')
})

test('an active temporary display shows a ring dot, minutes left and the way back', () => {
  const until = NOW + 7 * 60000 + 1
  const text = inkStatusText(
    make({ showing: { kind: 'ambient', title: '概念卡《机会成本》' }, temporary: { kind: 'ambient', title: '概念卡《机会成本》', until } }),
    NOW,
    'zh',
  )
  assert.equal(text.state, 'temporary')
  assert.equal(text.dot, 'ring')
  assert.equal(text.headline, '正在临时展示：概念卡《机会成本》')
  assert.deepEqual(text.messages, ['剩 8 分钟'])
  assert.equal(text.action, 'end-temporary')
  assert.equal(text.actionLabel, '回到工作画面')
})

test('a temporary display hidden by an alert keeps counting down and shows the slot note', () => {
  const note = '授权或异常提醒优先，临时展示暂停'
  const text = inkStatusText(
    make({ showing: { kind: 'work' }, temporary: { kind: 'todos', title: '待办', until: NOW + 3 * 60000 }, slotNote: note }),
    NOW,
    'zh',
  )
  assert.equal(text.state, 'temporary')
  assert.equal(text.headline, '临时展示已暂停：待办')
  assert.deepEqual(text.messages, ['剩 3 分钟'])
  assert.equal(text.note, note)
  assert.equal(text.action, 'end-temporary')
})

test('slotNote is kept as one muted line for a connected screen and never for a stopped service', () => {
  const note = '桌边内容时段：今日展示已达上限，暂显示工作画面'
  assert.equal(inkStatusText(make({ slotNote: note }), NOW, 'zh').note, note)
  assert.equal(inkStatusText(make({ slotNote: '  ' }), NOW, 'zh').note, '')
  assert.equal(inkStatusText(make({ connection: 'server-off', slotNote: note }), NOW, 'zh').note, '')
})

test('minutes never go negative once a deadline has passed', () => {
  const text = inkStatusText(
    make({ showing: { kind: 'ambient', title: 'x' }, temporary: { kind: 'ambient', title: 'x', until: NOW - 1000 } }),
    NOW,
    'zh',
  )
  assert.deepEqual(text.messages, ['剩 0 分钟'])
})

test('English wording mirrors every state', () => {
  assert.equal(inkStatusText(make({ connection: 'server-off' }), NOW, 'en').headline, 'E-paper · device service is off')
  assert.equal(inkStatusText(make({ connection: 'disconnected' }), NOW, 'en').actionLabel, 'Connect device')
  const next = inkStatusText(make({ next: { feature: 'todos', at: NOW + 60000 } }), NOW, 'en')
  assert.equal(next.messages[0], 'Showing: work screen')
  assert.match(next.messages[1]!, /^Next: Tasks & reminders · \d\d:\d\d \(in 1 min\)$/)
  assert.equal(inkStatusText(make({ mode: 'single' }), NOW, 'en').messages[1], 'Fixed: work screen')
  const temp = inkStatusText(make({ showing: { kind: 'ambient', title: 'Card' }, temporary: { kind: 'ambient', title: 'Card', until: NOW + 120000 } }), NOW, 'en')
  assert.equal(temp.headline, 'Temporary display: Card')
  assert.equal(temp.actionLabel, 'Back to work screen')
})

const plan = (patch: Partial<InkDisplayPlan>): InkDisplayPlan => ({ mode: 'cycle', fixed: 'work', items: ['work', 'ambient'], intervalMinutes: 15, ...patch })

test('plan chip reflects the applied playlist and adds the connect note offline', () => {
  assert.deepEqual(inkPlanChip(plan({}), 'ambient', 'connected', 'zh'), { included: true, text: '已在节目单中 · 每项 15 分钟' })
  assert.deepEqual(inkPlanChip(plan({}), 'ambient', 'disconnected', 'zh'), { included: true, text: '已在节目单中 · 每项 15 分钟（连接后生效）' })
  assert.deepEqual(inkPlanChip(plan({}), 'todos', 'connected', 'zh'), { included: false, text: '未加入节目单' })
  assert.equal(inkPlanChip(plan({ mode: 'single' }), 'ambient', 'connected', 'zh').text, '固定显示工作画面时不出现')
  assert.equal(inkPlanChip(plan({ mode: 'single' }), 'todos', 'server-off', 'zh').text, '固定显示工作画面时不出现（连接后生效）')
  assert.match(inkPlanChip(plan({ items: ['work', 'todos'], intervalMinutes: 10 }), 'todos', undefined, 'en').text, /^In the playlist · 10 min each/)
})

// Run against a native build of preview/renderer.c and the shipped JS loader:
// node preview/test-preview.mjs renderer.wasm native.exe renderer.mjs output-dir
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
const [wasm, native, loader, output] = process.argv.slice(2).map((p) => resolve(p))
const { createDeviceRenderer, frameToRgba } = await import(pathToFileURL(loader))
const bytes = readFileSync(wasm)
const render = await createDeviceRenderer(bytes)
// Exercise the new export directly while retaining parity with the existing
// read-only desktop BW loader, which can be updated independently.
const module = await WebAssembly.compile(bytes),
  wasi = Object.create(null)
let memory
for (const entry of WebAssembly.Module.imports(module)) {
  assert.equal(entry.module, 'wasi_snapshot_preview1')
  assert.equal(entry.kind, 'function')
  wasi[entry.name] =
    entry.name === 'random_get'
      ? (pointer, length) => {
          if (length > 65536 || pointer < 0 || pointer + length > memory.buffer.byteLength)
            return 21
          globalThis.crypto.getRandomValues(new Uint8Array(memory.buffer, pointer, length))
          return 0
        }
      : () => {
          throw new Error(`Unexpected preview host I/O: ${entry.name}`)
        }
}
const { exports: api } = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi })
memory = api.memory
api._initialize?.()
assert.equal(typeof api.preview_red_frame, 'function')
function renderPlanes(status) {
  const input = new TextEncoder().encode(JSON.stringify(status))
  assert.ok(input.length < api.preview_capacity())
  new Uint8Array(api.memory.buffer, api.preview_input(), input.length).set(input)
  assert.equal(api.preview_render(input.length, 0, 0, 0, -1, 0), 0)
  assert.equal(api.preview_size(), 15000)
  return {
    black: new Uint8Array(api.memory.buffer, api.preview_frame(), 15000).slice(),
    red: new Uint8Array(api.memory.buffer, api.preview_red_frame(), 15000).slice(),
  }
}
mkdirSync(output, { recursive: true })
const types = ['codex', 'claude_code', 'grok']
const config = {
  version: 1,
  mode: 'hud',
  metric: 'remaining',
  showQuota: true,
  showEnvironment: true,
  agents: types,
  page: 0,
}
function data(count = 3) {
  return {
    protocolVersion: 1,
    revision: 'preview-v016',
    mainState: 'running',
    agents: types.map((type, i) => ({
      type,
      state: 'idle',
      project: null,
      model: null,
      quotas: [
        {
          id: type,
          weekly: { usedPercent: [53, 9, null][i], resetsAt: 1793000000 },
          fiveHour: { usedPercent: i === 1 ? 30 : null },
        },
      ],
    })),
    display: { ...config },
    threadTotal: count,
    threads: Array.from({ length: count }, (_, i) => ({
      id: `t-${i}`,
      type: i % 3 === 1 ? 'claude_code' : 'codex',
      state: ['waiting_permission', 'thinking', 'done'][i % 3],
      title: ['CodePulse · 低闪烁看板', '固件 · 状态同步', 'HUD · 桌面布局'][i % 3],
      detail: ['运行测试需要你的确认', '检查显示区域与状态映射', '界面调整完成，等待查看'][i % 3],
    })),
  }
}
const cases = [0, 1, 2, 3, 4, 6, 7, 9].map((n) => [`hud-${n}`, data(n)])
for (const base of [data(0), data(4), data(9)]) {
  const inverted = { ...base, display: { ...base.display, inverted: true } }
  // Task colours use red; inversion complements black/white and red stays red (as for life cards).
  const normal = renderPlanes(base),
    flipped = renderPlanes(inverted)
  assert.deepEqual(flipped.red, normal.red, 'Inversion keeps red ink')
  assert.deepEqual(
    flipped.black,
    normal.black.map((n, i) => (n ^ 255) | (normal.red[i] ^ 255)),
    'Inversion must complement every BW pixel',
  )
  cases.push(['inverted-' + base.threadTotal, inverted])
}
assert.throws(() => render({ ...data(0), display: { ...config, inverted: 'yes' } }))
cases.push(['usage', { ...data(0), display: { ...config, mode: 'usage' } }])
cases.push([
  'minimal',
  { ...data(3), display: { ...config, showQuota: false, showEnvironment: false } },
])
cases.push(['used', { ...data(9), display: { ...config, metric: 'used' } }])
cases.push(['page-2', { ...data(3), threadTotal: 12, display: { ...config, page: 1 } }])
cases.push(['empty-accounts', { ...data(0), display: { ...config, mode: 'usage', agents: [] } }])
const long = data(3)
long.threads[0].title = '多语言 CodePulse 很长的项目标题需要省略处理'
long.threads[1].title = 'jp-work-proxy'
long.threads[2].title = 'unsupported 🐱'
cases.push(['long-title', long])
for (const state of [
  'idle',
  'cancelled',
  'prompt_submitted',
  'tool_running',
  'waiting_user_input',
  'error',
  'timeout',
  'usage_limited',
]) {
  const input = data(1)
  input.threads[0].state = state
  cases.push([state, input])
}
const spark = data(3)
spark.agents[0].model = 'gpt-5.3-codex-spark'
spark.agents[0].quotas.push({ id: 'spark', weekly: { usedPercent: 15.5 } })
cases.push(['spark-rounding', spark])
for (const file of readdirSync(new URL('./fixtures/', import.meta.url)).filter((f) =>
  f.endsWith('.json'),
)) {
  cases.push([
    'approved-' + file.slice(0, -5),
    JSON.parse(readFileSync(new URL('./fixtures/' + file, import.meta.url), 'utf8')),
  ])
}
const news = {
  ...data(0),
  mainState: 'idle',
  ambient: {
    id: 'desk-news',
    source: '@Polymarket',
    text: '示例排版 · 这是一条用于验证显示的测试贴文，不是真实新闻。 Source text stays attributed. A quiet moment beside your work.',
  },
}
const meme = {
  ...news,
  ambient: {
    id: 'desk-meme',
    source: 'r/memes',
    text: 'Bitmap layout test',
    imageHex: 'aa55'.repeat((384 * 208) / 8 / 2),
  },
}
for (const [name, base] of [
  ['text', news],
  ['image', meme],
  ['usage', { ...data(0), display: { ...config, mode: 'usage' } }],
]) {
  const inverse = { ...base, display: { ...base.display, inverted: true } }
  assert.deepEqual(
    render(inverse),
    render(base).map((n) => n ^ 255),
  )
  cases.push(['inverted-' + name, inverse])
}
cases.push(
  ['ambient-news', news],
  ['ambient-meme', meme],
  ['ambient-urgent', { ...data(1), ambient: news.ambient }],
)
for (const imageHex of ['00', 'gg'.repeat((384 * 208) / 8), '00'.repeat((384 * 208) / 8 + 1)])
  assert.throws(() => render({ ...news, ambient: { ...news.ambient, imageHex } }))
assert.throws(() => render({ ...news, ambient: { ...news.ambient, text: 'x'.repeat(768) } }))
assert.deepEqual(
  render({ ...data(1), ambient: news.ambient }),
  render(data(1)),
  'Agent attention must suppress ambient content',
)
assert.notDeepEqual(render(news), render(data(0)), 'News must actually be rendered')
assert.notDeepEqual(render(news), render(meme), 'Bitmap must actually be rendered')
const petBlack = Buffer.alloc((384 * 208) / 8),
  petRed = Buffer.alloc((128 * 128) / 8)
function dot(bits, width, x, y) {
  const bit = y * width + x
  bits[bit >> 3] |= 0x80 >> (bit & 7)
}
for (let y = 16; y < 112; y++)
  for (let x = 12; x < 116; x++) {
    const ear = y < 36 && ((x >= 20 && x < 40) || (x >= 88 && x < 108))
    const face = y >= 36 && y < 100 && (x < 16 || x >= 112 || y < 40 || y >= 96)
    const eye = y >= 52 && y < 60 && ((x >= 36 && x < 44) || (x >= 84 && x < 92))
    const mouth = y >= 76 && y < 80 && x >= 52 && x < 76
    if (ear || face || eye || mouth) dot(petBlack, 384, 128 + x, 40 + y)
    if (y >= 64 && y < 72 && ((x >= 24 && x < 36) || (x >= 92 && x < 104))) dot(petRed, 128, x, y)
  }
const pet = {
  ...news,
  ambient: {
    id: 'pet:cat:calm:2026-10-29',
    source: '像素宠物',
    text: 'Pixel pet · quiet moment',
    imageHex: petBlack.toString('hex'),
    red: { x: 128, y: 40, w: 128, h: 128, hex: petRed.toString('hex') },
  },
}
const petPlanes = renderPlanes(pet),
  inversePet = { ...pet, display: { ...pet.display, inverted: true } }
const inversePlanes = renderPlanes(inversePet)
assert.deepEqual(petPlanes.black, render(pet))
assert.deepEqual(inversePlanes.red, petPlanes.red, 'Inversion must preserve red pigment')
const cheek = (60 + 40 + 64) * 50 + (8 + 128 + 24) / 8
assert.equal(petPlanes.red[cheek], 0)
assert.equal(petPlanes.black[cheek], 255)
for (let i = 0; i < 15000; i++) {
  assert.equal(petPlanes.black[i] | petPlanes.red[i], 255, 'Black/red conflict')
  assert.equal(inversePlanes.black[i] | inversePlanes.red[i], 255, 'Inverted black/red conflict')
  assert.equal(inversePlanes.black[i], (petPlanes.black[i] ^ 255) | (petPlanes.red[i] ^ 255))
}
cases.push(['pet-red', pet], ['pet-red-inverted', inversePet])
const overlapImage = Buffer.from(petBlack)
dot(overlapImage, 384, 128, 40)
const overlapPet = {
  ...pet,
  ambient: {
    ...pet.ambient,
    imageHex: overlapImage.toString('hex'),
    red: { x: 128, y: 40, w: 8, h: 1, hex: '80' },
  },
}
const overlapPlanes = renderPlanes(overlapPet)
assert.ok(
  overlapPlanes.red.every((n) => n === 255),
  'Black must win red overlap',
)
assert.equal(overlapPlanes.black[100 * 50 + 17] & 0x80, 0)
cases.push(['pet-black-priority', overlapPet])
const edgePet = {
  ...pet,
  ambient: { ...pet.ambient, red: { x: 376, y: 207, w: 8, h: 1, hex: '81' } },
}
const edgeRed = renderPlanes(edgePet).red
assert.equal(edgeRed[267 * 50 + 48], 0x7e)
cases.push(['pet-red-edge', edgePet])
const maxPet = {
  ...pet,
  ambient: { ...pet.ambient, red: { x: 0, y: 144, w: 384, h: 64, hex: 'ff'.repeat(3072) } },
}
cases.push(['pet-red-max', maxPet])
for (const [name, red] of [
  ['bounds', { x: 384, y: 0, w: 8, h: 1, hex: '80' }],
  ['alignment', { x: 1, y: 0, w: 8, h: 1, hex: '80' }],
  ['length', { ...pet.ambient.red, hex: '80' }],
  ['capacity', { x: 0, y: 0, w: 384, h: 65, hex: 'ff'.repeat(3120) }],
  ['type', 'red'],
]) {
  const input = { ...pet, ambient: { ...pet.ambient, red } }
  assert.deepEqual(render(input), render({ ...pet, ambient: { ...pet.ambient, red: null } }))
  assert.ok(
    renderPlanes(input).red.every((n) => n === 255),
    `${name}: invalid red must be ignored`,
  )
  cases.push(['pet-red-invalid-' + name, input])
}
const textPet = { ...news, ambient: { ...news.ambient, red: pet.ambient.red } }
assert.deepEqual(render(textPet), render(news))
assert.ok(renderPlanes(textPet).red.every((n) => n === 255))
cases.push(['pet-red-without-image', textPet])
assert.deepEqual(
  renderPlanes(news).red,
  new Uint8Array(15000).fill(255),
  'Red must clear between cards',
)
const petLayout = {
  ...pet,
  ambient: { ...pet.ambient, layout: 'pet', text: '我在晒太阳，你忙你的。' },
}
const layoutPlanes = renderPlanes(petLayout)
assert.equal(layoutPlanes.red[(32 + 40 + 64) * 50 + (8 + 128 + 24) / 8], 0)
for (let y = 0; y < 208; y++)
  assert.deepEqual(
    layoutPlanes.red.subarray((32 + y) * 50, (33 + y) * 50),
    petPlanes.red.subarray((60 + y) * 50, (61 + y) * 50),
  )
const inverseLayout = { ...petLayout, display: { ...petLayout.display, inverted: true } }
const inverseLayoutPlanes = renderPlanes(inverseLayout)
assert.deepEqual(inverseLayoutPlanes.red, layoutPlanes.red)
for (let i = 0; i < 15000; i++) {
  assert.equal(layoutPlanes.black[i] | layoutPlanes.red[i], 255)
  assert.equal(
    inverseLayoutPlanes.black[i],
    (layoutPlanes.black[i] ^ 255) | (layoutPlanes.red[i] ^ 255),
  )
}
cases.push(['pet-layout-red', petLayout], ['pet-layout-red-inverted', inverseLayout])
cases.push([
  'pet-layout-wide',
  { ...petLayout, ambient: { ...petLayout.ambient, text: '中'.repeat(80) } },
])
cases.push([
  'pet-layout-wide-cjk',
  {
    ...petLayout,
    ambient: {
      ...petLayout.ambient,
      text: '像素宠物 · 团团 像素宠物 · 芽芽 像素宠物 · 方方 像素宠物',
    },
  },
])
const layoutEdge = { ...edgePet, ambient: { ...edgePet.ambient, layout: 'pet' } }
assert.equal(renderPlanes(layoutEdge).red[239 * 50 + 48], 0x7e)
cases.push(['pet-layout-red-edge', layoutEdge])
for (const [name, layout] of [
  ['absent', undefined],
  ['null', null],
  ['unknown', 'future'],
  ['number', 42],
  ['object', {}],
  ['array', []],
  ['boolean', true],
]) {
  const input = { ...pet, ambient: { ...pet.ambient, layout } }
  assert.deepEqual(
    renderPlanes(input),
    petPlanes,
    `${name}: layout must fall back without rejecting status`,
  )
  cases.push(['layout-ignore-' + name, input])
}
for (const imageHex of [undefined, null]) {
  const input = { ...textPet, ambient: { ...textPet.ambient, imageHex, layout: 'pet' } }
  assert.deepEqual(
    renderPlanes(input),
    renderPlanes(news),
    'Pet layout without image must keep the text layout',
  )
  cases.push(['pet-layout-no-image-' + String(imageHex), input])
}
// Shared presentation semantics: unchanged source state can change its visible level.
const calendarOctober = JSON.parse(
  readFileSync(new URL('./fixtures/calendar-2026-10.json', import.meta.url), 'utf8'),
)
const calendarFrame = renderPlanes(calendarOctober)
const inverseCalendar = {
  ...calendarOctober,
  display: { ...calendarOctober.display, inverted: true },
}
const inverseCalendarFrame = renderPlanes(inverseCalendar)
assert.deepEqual(inverseCalendarFrame.red, calendarFrame.red)
for (let y = 0; y < 300; y++)
  for (let x = 0; x < 400; x++) {
    const i = y * 50 + (x >> 3),
      bit = 128 >> (x & 7)
    const expected = ((calendarFrame.black[i] ^ 255) | (calendarFrame.red[i] ^ 255)) & bit
    if ((inverseCalendarFrame.black[i] & bit) !== expected) {
      const dx = 2 * (x - (253 - 23)) + 1 - 46,
        dy = 2 * (y - (274 - 23)) + 1 - 46
      assert.ok(
        dx * dx + dy * dy <= 46 * 46,
        'Only the today-circle white foreground bypasses inversion',
      )
      assert.ok(inverseCalendarFrame.black[i] & bit)
      assert.ok(inverseCalendarFrame.red[i] & bit)
    }
  }
cases.push(['calendar-inverted', inverseCalendar])
const longCalendar = structuredClone(calendarOctober)
longCalendar.ambient.calendar.labels[29] = '春节快乐'
const sixCalendar = JSON.parse(
  readFileSync(new URL('./fixtures/calendar-2026-08.json', import.meta.url), 'utf8'),
)
sixCalendar.ambient.calendar.today = 31
sixCalendar.ambient.calendar.labels[30] = '四字标签'
const workCalendar = structuredClone(calendarOctober)
workCalendar.ambient.calendar.today = 10
for (const [name, status] of [
  ['four-label', longCalendar],
  ['six-four-label', sixCalendar],
  ['today-work', workCalendar],
]) {
  cases.push(
    ['calendar-' + name, status],
    [
      'calendar-' + name + '-inverted',
      { ...status, display: { ...status.display, inverted: true } },
    ],
  )
}
const calendarImage = {
  ...calendarOctober,
  ambient: { ...calendarOctober.ambient, imageHex: 'invalid', red: pet.ambient.red },
}
assert.deepEqual(renderPlanes(calendarImage), calendarFrame, 'A valid calendar ignores image/red')
cases.push(['calendar-image-priority', calendarImage])
for (const [name, calendar] of [
  ['missing', undefined],
  ['null', null],
  ['number', 42],
  ['object', {}],
  ['range', { ...calendarOctober.ambient.calendar, today: 32 }],
  ['length', { ...calendarOctober.ambient.calendar, labels: [] }],
  ['flags', { ...calendarOctober.ambient.calendar, flags: Array(31).fill(13) }],
]) {
  const input = { ...calendarOctober, ambient: { ...calendarOctober.ambient, calendar } }
  const fallback = {
    ...input,
    ambient: { ...input.ambient, layout: undefined, calendar: undefined },
  }
  assert.deepEqual(
    renderPlanes(input),
    renderPlanes(fallback),
    'Invalid calendar keeps the valid text card',
  )
  cases.push(['calendar-invalid-' + name, input])
  const image = {
    ...input,
    ambient: { ...input.ambient, imageHex: pet.ambient.imageHex, red: pet.ambient.red },
  }
  const imageFallback = {
    ...image,
    ambient: { ...image.ambient, layout: undefined, calendar: undefined },
  }
  assert.deepEqual(
    renderPlanes(image),
    renderPlanes(imageFallback),
    'Invalid calendar keeps the valid image card',
  )
  cases.push(['calendar-invalid-image-' + name, image])
}
const shared = JSON.parse(
  readFileSync(new URL('./fixtures/work-parity-4.json', import.meta.url), 'utf8'),
)
const single = {
  ...structuredClone(shared),
  threadTotal: 1,
  threads: [structuredClone(shared.threads[0])],
}
cases.push(
  ['shared-single', single],
  ['shared-single-used', { ...single, display: { ...single.display, metric: 'used' } }],
)
for (const level of ['quiet', 'active', 'notice', 'action', 'fault']) {
  const input = structuredClone(single)
  input.threads[0].state = 'done'
  input.threads[0].level = level
  input.threads[0].unread = level !== 'quiet'
  cases.push(['shared-level-' + level, input])
}
const read = structuredClone(single)
read.threads[0].state = 'done'
read.threads[0].level = 'quiet'
read.threads[0].unread = false
const unread = structuredClone(read)
unread.threads[0].level = 'notice'
unread.threads[0].unread = true
assert.notDeepEqual(
  render(read),
  render(unread),
  'Read DONE must be visibly quiet instead of requiring review',
)
// Review badges retain a solid black background at every supported density.
for (const n of [1, 6, 9]) {
  const input = data(n)
  for (const thread of input.threads)
    Object.assign(thread, { state: 'done', level: 'notice', unread: true })
  const pixels = frameToRgba(render(input))
  // Approved HUD A (0.0.32): pills at x322, 66 wide; roomy rows for 1-3 tasks, list rows above.
  const [x, y, w, h] = n === 1 ? [322, 54, 66, 32] : n === 6 ? [322, 41, 66, 21] : [322, 35, 66, 21]
  let black = 0
  for (let py = y; py < y + h; py++)
    for (let px = x; px < x + w; px++) if (!pixels[(py * 400 + px) * 4]) black++
  assert.ok(
    black > w * h * 0.6 && black < w * h * 0.95,
    `Review badge at ${n} tasks must be solid with white text`,
  )
  cases.push(['review-filled-' + n, input])
  const inverse = { ...input, display: { ...input.display, inverted: true } }
  assert.deepEqual(
    render(inverse),
    render(input).map((n) => n ^ 255),
  )
  cases.push(['review-filled-inverted-' + n, inverse])
}
const manualPicture = { ...unread, ambient: { ...meme.ambient, manual: true } }
assert.deepEqual(
  render(manualPicture),
  render({ ...read, ambient: meme.ambient }),
  'Manual image must cover review notices',
)
assert.deepEqual(
  render({ ...unread, ambient: meme.ambient }),
  render(unread),
  'Automatic content must still yield to review',
)
cases.push(
  ['manual-over-review', manualPicture],
  ['automatic-under-review', { ...unread, ambient: meme.ambient }],
)
for (const level of ['action', 'fault']) {
  const work = { ...unread, threads: [{ ...unread.threads[0], level }] }
  const picture = { ...work, ambient: manualPicture.ambient }
  assert.deepEqual(render(picture), render(work), `${level} must interrupt manual content`)
  cases.push(['manual-under-' + level, picture])
}
assert.throws(() =>
  render({ ...manualPicture, ambient: { ...manualPicture.ambient, manual: 'yes' } }),
)
const busyThinking = structuredClone(single)
Object.assign(busyThinking.threads[0], {
  title: 'CodePulse',
  state: 'thinking',
  level: 'active',
  detail: 'AI 正在思考',
})
const busyTool = structuredClone(busyThinking)
Object.assign(busyTool.threads[0], {
  state: 'tool_running',
  detail: '正在执行 Bash，工具路径发生变化',
})
assert.deepEqual(
  render(busyThinking),
  render(busyTool),
  'Busy substages must share stable physical pixels',
)
cases.push(['paced-thinking', busyThinking], ['paced-tool', busyTool])
const rawChanged = structuredClone(single)
for (const a of rawChanged.agents) {
  a.quotas = [{ id: a.type, weekly: { usedPercent: 99 }, fiveHour: { usedPercent: 99 } }]
}
assert.deepEqual(
  render(rawChanged),
  render(single),
  'Host summaries must override legacy quota selection',
)
const fiveChanged = structuredClone(single)
fiveChanged.agents.find((a) => a.type === 'claude_code').quotaSummary.fiveHourUsedPercent = 28
assert.notDeepEqual(render(fiveChanged), render(single), '5h changes must be visible')
const allAccounts = structuredClone(single)
allAccounts.display.agents = types
allAccounts.agents.push({
  type: 'grok',
  state: 'idle',
  quotas: [],
  quotaSummary: { fiveHourUsedPercent: null, weeklyUsedPercent: 100 },
})
const claude = allAccounts.agents.find((a) => a.type === 'claude_code')
claude.quotaSummary = { fiveHourUsedPercent: 100, weeklyUsedPercent: 100 }
allAccounts.display.metric = 'used'
cases.push(['shared-max-footer', allAccounts])
const unknown = structuredClone(single)
for (const a of unknown.agents)
  a.quotaSummary = { fiveHourUsedPercent: null, weeklyUsedPercent: null }
cases.push(['shared-unknown', unknown])
const legacyUnknown = structuredClone(unknown)
for (const a of legacyUnknown.agents) {
  delete a.quotaSummary
  a.quotas = []
}
assert.deepEqual(
  render(unknown),
  render(legacyUnknown),
  'Null summaries must not revive old percentages',
)
const outputs = []
const todoBase = {
  ...data(0),
  mainState: 'idle',
  ambient: {
    id: 'todo-sample',
    source: '待办与提醒 · 6 项',
    text: '兼容旧固件的待办文字',
    items: Array.from({ length: 6 }, (_, i) => ({
      title: ['整理课堂反馈', '完成 CodePulse 接入验证', '读完这一章并做笔记'][i % 3],
      meta: '10/30 14:00',
      overdue: i === 0,
    })),
  },
}
for (const n of [0, 1, 6]) {
  const input = {
    ...todoBase,
    ambient: { ...todoBase.ambient, items: todoBase.ambient.items.slice(0, n) },
  }
  cases.push(['todos-' + n, input])
  const inverted = { ...input, display: { ...input.display, inverted: true } }
  assert.deepEqual(
    render(inverted),
    render(input).map((n) => n ^ 255),
  )
  cases.push(['todos-inverted-' + n, inverted])
}
assert.notDeepEqual(
  render(todoBase),
  render({ ...todoBase, ambient: { ...todoBase.ambient, items: undefined } }),
)
for (const items of [
  Array(7).fill(todoBase.ambient.items[0]),
  [{ title: '', meta: '', overdue: false }],
  [{ title: 'x', meta: '', overdue: 'yes' }],
])
  assert.throws(() => render({ ...todoBase, ambient: { ...todoBase.ambient, items } }))
assert.throws(() =>
  render({ ...todoBase, ambient: { ...todoBase.ambient, imageHex: meme.ambient.imageHex } }),
)
for (const [name, input] of cases) {
  const json = JSON.stringify(input),
    before = structuredClone(input)
  writeFileSync(join(output, `${name}.json`), json)
  execFileSync(native, [
    join(output, `${name}.json`),
    join(output, `${name}.native.bin`),
    join(output, `${name}.native.red.bin`),
  ])
  const pixels = render(input)
  const planes = renderPlanes(input)
  assert.deepEqual(
    pixels,
    new Uint8Array(readFileSync(join(output, `${name}.native.bin`))),
    `${name}: native/Wasm pixel mismatch`,
  )
  assert.deepEqual(planes.black, pixels, `${name}: new plane adapter changed BW pixels`)
  assert.deepEqual(
    planes.red,
    new Uint8Array(readFileSync(join(output, `${name}.native.red.bin`))),
    `${name}: native/Wasm red pixel mismatch`,
  )
  assert.deepEqual(input, before, 'Preview mutated the configuration/status')
  const rgba = frameToRgba(pixels)
  const gray = Buffer.from(Array.from({ length: 120000 }, (_, i) => rgba[i * 4]))
  writeFileSync(
    join(output, `${name}.pgm`),
    Buffer.concat([Buffer.from('P5\n400 300\n255\n'), gray]),
  )
  outputs.push([name, input])
}
const input = data(3),
  expected = render(input)
const expectedPlanes = renderPlanes(input)
for (let i = 0; i < 200; i++) {
  render(cases[i % cases.length][1])
  assert.deepEqual(render(input), expected)
  renderPlanes(cases[i % cases.length][1])
  assert.deepEqual(renderPlanes(input), expectedPlanes)
}
assert.throws(() => render({ ...data(), protocolVersion: 2 }))
assert.throws(() => render({ ...data(), threads: Array(10).fill(data(1).threads[0]) }))
assert.throws(() => render({ ...data(), message: 'x'.repeat(65536) }))
assert.deepEqual(render(input), expected, 'Renderer did not recover after invalid input')
assert.throws(() => frameToRgba(new Uint8Array(10)))
writeFileSync(join(output, 'fixtures.json'), JSON.stringify(Object.fromEntries(outputs), null, 2))
console.log(
  `PASS: ${cases.length} native/Wasm black/red pixel-identical cases; 400 BW + 400 two-plane repeated renders, immutable inputs, malformed/oversize data rejected.`,
)

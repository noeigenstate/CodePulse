import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createDeviceRenderer } from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'
import {
  deskContentIncluded,
  deskPerformancePlayback,
  inkRotationItems,
  mergeInkControlPlan,
  setDeskContentIncluded,
  updateDeskPerformance,
  type InkDisplayPlan,
  DEFAULT_INK_PLAN,
  PERFORMANCE_LAYOUTS,
  normalizeInkPlan,
  normalizePerformanceOptions,
  type DeviceStatusV1,
} from '@codepulse/shared'
import {
  PerformanceCollector,
  readings,
  type PerformanceReading,
} from '../apps/desktop/src/main/performance-collector.js'
import {
  attachPerformance,
  makePerformanceCard,
  makePerformancePreview,
  PerformanceFrames,
} from '../apps/desktop/src/main/performance-card.js'
import { inkFeatureAt } from '../apps/desktop/src/main/ambient-plan.js'
import { inkControlChanges } from '../apps/desktop/src/renderer/src/components/product-control-state.js'
import { DEFAULT_DEVICE_DISPLAY } from '@codepulse/shared'
const gib = 2 ** 30
const options = normalizePerformanceOptions()
const cp = (user: number, idle: number) => ({
  model: 'CPU',
  speed: 2300,
  times: { user, idle, nice: 0, irq: 0, sys: 0 },
})
const seed = (at: number) => ({
  at,
  cpus: [cp(100, 100), cp(100, 100)],
  gpus: [],
  total: 64 * gib,
  free: 20 * gib,
})
const sample: PerformanceReading = {
  cores: [96, 92, 0, 15, 72, 68, 0, 4, 88, 75, 0, 48, 55, 32, 6, 0, 94, 60, 12, 19],
  cpu: 42,
  model: 'Intel Core i7-12700',
  total: 64 * gib,
  used: 44 * gib,
  gpus: [
    {
      id: 'pci-01:00.0',
      name: 'RTX 4090',
      engine: 'CUDA',
      compute: 91,
      graphics: 7,
      used: 18 * gib,
      total: 24 * gib,
    },
  ],
}

test('performance is opt-in, fixed and cycling both survive normalization, and legacy plans still work', () => {
  assert.equal(options.layout, 'detail')
  assert.deepEqual(
    inkControlChanges(
      { ...DEFAULT_INK_PLAN, performance: options },
      DEFAULT_DEVICE_DISPLAY,
      DEFAULT_INK_PLAN,
    ),
    [],
  )
  assert.deepEqual(normalizeInkPlan(DEFAULT_INK_PLAN), DEFAULT_INK_PLAN)
  const fixed = normalizeInkPlan({
    ...updateDeskPerformance(DEFAULT_INK_PLAN, { playback: 'fixed' }),
    performance: { layout: 'gpu', gpu: 'pci-01:00.0', page: 2 },
  })
  assert.equal(inkFeatureAt(fixed, 0), 'performance')
  assert.equal(fixed.performance?.gpu, 'pci-01:00.0')
  const cycle = normalizeInkPlan({
    ...fixed,
    mode: 'cycle',
    items: ['work', 'performance', 'performance'],
    intervalMinutes: 5,
  })
  assert.equal(inkFeatureAt(cycle, 300000), 'performance')
  assert.equal(inkFeatureAt(cycle, 600000), 'work')
  assert.equal(normalizeInkPlan({ mode: 'single', fixed: 'todos' }).mode, 'cycle')
  assert.ok(inkControlChanges(fixed, DEFAULT_DEVICE_DISPLAY, DEFAULT_INK_PLAN).includes('playback'))
})
test('desk content owns performance, pausing the group preserves legacy slot order and pin settings', () => {
  const legacy = normalizeInkPlan({
    ...DEFAULT_INK_PLAN,
    items: ['work', 'performance', 'todos', 'ambient'],
    performance: { layout: 'gpu', gpu: 'pci-01:00.0', page: 2 },
  })
  const paused = normalizeInkPlan(setDeskContentIncluded(legacy, false))
  assert.equal(deskContentIncluded(paused), false)
  assert.deepEqual(inkRotationItems(paused), ['work', 'todos'])
  assert.equal(inkFeatureAt(paused, 900000), 'todos')
  assert.deepEqual(setDeskContentIncluded(paused, true), legacy)
  const layout = updateDeskPerformance(paused, { options: { layout: 'balanced' } })
  assert.equal(deskPerformancePlayback(layout), 'cycle')
  assert.equal(layout.deskContentPaused, true)
  assert.deepEqual(inkRotationItems(updateDeskPerformance(layout, { playback: 'preview' })), [
    'work',
    'todos',
  ])
  assert.equal(layout.performance?.gpu, legacy.performance?.gpu)
  const pinned = updateDeskPerformance(layout, { playback: 'fixed' })
  assert.equal(inkFeatureAt(pinned, 0), 'performance')
  const rotated = updateDeskPerformance(pinned, { playback: 'cycle' })
  assert.equal(deskPerformancePlayback(rotated), 'cycle')
  assert.deepEqual(rotated.items, legacy.items)
  assert.equal(rotated.deskContentPaused, undefined)
  const removed = updateDeskPerformance(rotated, { playback: 'preview' })
  assert.deepEqual(removed.items, ['work', 'todos', 'ambient'])
  const controlDraft: InkDisplayPlan = {
    ...legacy,
    intervalMinutes: 10,
    items: ['work', 'performance', 'ambient'],
  }
  const simultaneous = updateDeskPerformance(legacy, {
    playback: 'fixed',
    options: { layout: 'balanced' },
  })
  const merged = mergeInkControlPlan(legacy, controlDraft, simultaneous)
  assert.equal(merged.fixed, 'performance')
  assert.equal(merged.performance?.layout, 'balanced')
  assert.equal(merged.intervalMinutes, 10)
  assert.deepEqual(merged.items, controlDraft.items)
})
test('concurrent viewers share one pull, warming uses deltas, no timer samples after last request', async () => {
  let now = 0,
    calls = 0
  const collector = new PerformanceCollector(
    async () => {
      calls++
      return seed(now)
    },
    () => now,
  )
  const a = collector.pull(),
    b = collector.pull()
  assert.equal(a, b)
  assert.equal((await a)?.cpu, null)
  now = 900
  await collector.pull()
  assert.equal(calls, 1)
  now = 1500
  await collector.pull()
  assert.equal(calls, 2)
  now = 29999
  await collector.pull()
  assert.equal(calls, 2)
  now = 100000
  assert.equal(collector.recent(), undefined)
  assert.equal(calls, 2)
  assert.equal((await collector.pull())?.cpu, null)
  assert.equal(calls, 3)
})
test('per-core deltas use all cores for the headline; CUDA and 3D use their own adapter and nodes', () => {
  const gpu = {
    id: 'pci-01:00.0',
    name: 'GPU',
    total: 24 * gib,
    used: 18 * gib,
    nodes: [
      [0, '3d', 0],
      [1, 'cuda', 0],
      [3, 'compute', 0],
    ] as [number, 'cuda' | 'compute' | '3d', number][],
  }
  const before = { ...seed(0), gpus: [gpu] }
  const after = {
    ...seed(1000),
    cpus: [cp(200, 100), cp(100, 200)],
    gpus: [
      {
        ...gpu,
        nodes: [
          [0, '3d', 700000],
          [1, 'cuda', 9100000],
          [3, 'compute', 9900000],
        ] as typeof gpu.nodes,
      },
    ],
  }
  const read = readings(after, before)
  assert.deepEqual(read.cores, [100, 0])
  assert.equal(read.cpu, 50)
  assert.equal(read.gpus[0]?.compute, 91)
  assert.equal(read.gpus[0]?.graphics, 7)
  assert.equal(
    readings({ ...after, gpus: [{ ...gpu, id: 'pci-04:00.0' }] }, before).gpus[0]?.compute,
    null,
  )
  assert.equal(
    readings({ ...after, gpus: [{ ...gpu, nodes: [] }] }, before).gpus[0]?.graphics,
    null,
  )
})
test('distinct layouts, missing counters, large CPU groups and two equal-name GPU choices use the firmware bitmap', () => {
  const cards = ['detail', 'balanced', 'gpu'].map((layout) =>
    makePerformanceCard(sample, normalizePerformanceOptions({ layout })),
  )
  assert.equal(new Set(cards.map((c) => c.id)).size, 3)
  for (const c of cards) {
    assert.match(c.imageHex!, /^[0-9a-f]{19968}$/)
    assert.equal(c.red, undefined)
  }
  assert.equal(makePerformanceCard(sample, options).id, cards[0]!.id)
  const big = { ...sample, cores: [...sample.cores, 0, 100] }
  assert.match(makePerformanceCard(big, { ...options, page: 9 }).source, /2\/2/)
  assert.notEqual(
    makePerformanceCard(big, { ...options, page: 1 }).id,
    makePerformanceCard(big, options).id,
  )
  const other = { ...sample.gpus[0]!, id: 'pci-04:00.0', compute: 2, graphics: 88 }
  const two = { ...sample, gpus: [other, ...sample.gpus] }
  const automatic = makePerformanceCard(two, options)
  assert.equal(automatic.id, makePerformanceCard(two, { ...options, gpu: sample.gpus[0]!.id }).id)
  assert.notEqual(automatic.id, makePerformanceCard(two, { ...options, gpu: other.id }).id)
  const absent = makePerformanceCard({ ...sample, gpus: [] }, options)
  assert.notEqual(
    absent.id,
    makePerformanceCard({ ...sample, gpus: [{ ...other, compute: 0, graphics: 0 }] }, options).id,
  )
  const base: DeviceStatusV1 = {
    protocolVersion: 1,
    revision: 'a',
    mainState: 'idle',
    activeAgent: null,
    agents: [],
    message: '',
    updatedAt: 0,
  }
  assert.equal(attachPerformance(base, cards[0]!).ambient?.id, cards[0]!.id)
  const heavy = { ...base, message: 'x'.repeat(15000) }
  assert.equal(attachPerformance(heavy, cards[0]!), heavy)
})
test('the native renderer accepts the desktop performance preview with an offline device and a saved work page', async () => {
  const render = await createDeviceRenderer(
    readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm'),
  )
  const frames = new PerformanceFrames()
  const config = { ...DEFAULT_DEVICE_DISPLAY, page: 7, inverted: true }
  const images = new Set<string>()
  for (const layout of PERFORMANCE_LAYOUTS) {
    const { status } = makePerformancePreview(sample, { layout }, config, frames)
    assert.ok(status?.ambient)
    assert.equal(status.threadTotal, 0)
    assert.deepEqual(status.threads, [])
    assert.equal(status.display?.page, 0)
    assert.equal(status.display.inverted, true)
    const image = render(status)
    assert.equal(image.length, 15000)
    assert.notDeepEqual(image, render({ ...status, ambient: undefined }))
    images.add(Buffer.from(image).toString('base64'))
  }
  assert.equal(images.size, PERFORMANCE_LAYOUTS.length)
  assert.equal(config.page, 7)
  const cold = makePerformancePreview({ ...sample, cpu: null }, options, undefined, frames)
  assert.equal(cold.warming, true)
  assert.ok(cold.status?.ambient)
  assert.equal(render(cold.status).length, 15000)
})
test('panel holds the last changed frame for at least a minute while a separate preview stays current', () => {
  const ink = new PerformanceFrames(),
    preview = new PerformanceFrames()
  const first = ink.get(sample, options, 0, true)
  const busy = { ...sample, cpu: 95 }
  assert.equal(ink.get(busy, options, 59000, true), first)
  assert.notEqual(preview.get(busy, options, 59000, false).id, first.id)
  assert.equal(ink.get({ ...sample, cpu: 44 }, options, 61000, true), first)
  assert.notEqual(ink.get(busy, options, 62000, true).id, first.id)
  assert.equal(ink.get(sample, options, 119000, true).id, ink.get(busy, options, 62000, true).id)
  assert.notEqual(ink.get(sample, { ...options, layout: 'gpu' }, 119100, true).id, first.id)
})

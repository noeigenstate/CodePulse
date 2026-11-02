import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_DEVICE_DISPLAY, DEFAULT_INK_PLAN, type InkDisplayPlan } from '@codepulse/shared'
import {
  inkPlanChoice,
  selectInkPlan,
  inkControlChanges,
  nextInkBaseline,
} from '../apps/desktop/src/renderer/src/components/product-control-state.js'

test('ia2 select maps all dwell choices to a cycle without changing playlist membership', () => {
  const saved: InkDisplayPlan = { ...DEFAULT_INK_PLAN, items: ['work', 'todos'], mode: 'single' }
  for (const minutes of [5, 10, 15, 30] as const) {
    const next = selectInkPlan(saved, String(minutes))
    assert.equal(next.mode, 'cycle')
    assert.equal(next.fixed, 'work')
    assert.equal(next.intervalMinutes, minutes)
    assert.equal(inkPlanChoice(next), String(minutes))
    assert.deepEqual(next.items, ['work', 'todos'])
  }
  assert.deepEqual(saved, { ...DEFAULT_INK_PLAN, items: ['work', 'todos'], mode: 'single' })
})
test('ia2 fixed select retains cycle items and dwell and rejects unknown select values', () => {
  const saved: InkDisplayPlan = {
    ...DEFAULT_INK_PLAN,
    items: ['work', 'ambient', 'todos'],
    intervalMinutes: 30,
  }
  const fixed = selectInkPlan(saved, 'fixed')
  assert.equal(inkPlanChoice(fixed), 'fixed')
  assert.equal(fixed.mode, 'single')
  assert.equal(fixed.fixed, 'work')
  assert.deepEqual(fixed.items, saved.items)
  assert.equal(fixed.intervalMinutes, 30)
  assert.deepEqual(selectInkPlan(fixed, '30'), saved)
  assert.equal(selectInkPlan(saved, '7'), saved)
})
test('ia2 mode and dwell count as one pending change while membership and screen details count separately', () => {
  const fixed: InkDisplayPlan = { ...DEFAULT_INK_PLAN, mode: 'single' }
  const cycle = selectInkPlan(fixed, '5')
  assert.deepEqual(
    inkControlChanges(cycle, DEFAULT_DEVICE_DISPLAY, fixed, DEFAULT_DEVICE_DISPLAY),
    ['playback'],
  )
  assert.deepEqual(
    inkControlChanges(
      { ...fixed, intervalMinutes: 30 },
      DEFAULT_DEVICE_DISPLAY,
      fixed,
      DEFAULT_DEVICE_DISPLAY,
    ),
    [],
  )
  assert.deepEqual(
    inkControlChanges(
      { ...cycle, items: ['work', 'todos'] },
      { ...DEFAULT_DEVICE_DISPLAY, inverted: true },
      fixed,
      DEFAULT_DEVICE_DISPLAY,
    ),
    ['ambient', 'todos', 'playback', 'display'],
  )
  assert.deepEqual(
    inkControlChanges(cycle, DEFAULT_DEVICE_DISPLAY, cycle, DEFAULT_DEVICE_DISPLAY),
    [],
  )
})

test('offline baseline follows a connected device, then stays put while changes auto-apply', () => {
  const at15: InkDisplayPlan = { ...DEFAULT_INK_PLAN, intervalMinutes: 15 }
  const at5 = selectInkPlan(at15, '5')
  const display = DEFAULT_DEVICE_DISPLAY
  let baseline = nextInkBaseline(undefined, { connected: true, saving: false, plan: at15, display })
  assert.deepEqual(baseline?.plan, at15)
  // The device disconnects and the offline change auto-applies: the saved plan moves, the baseline does not.
  baseline = nextInkBaseline(baseline, { connected: false, saving: false, plan: at5, display })
  assert.deepEqual(baseline?.plan, at15)
  assert.deepEqual(inkControlChanges(at5, display, baseline!.plan, baseline!.display), ['playback'])
  // Changing back to the baseline clears the count.
  assert.deepEqual(inkControlChanges(at15, display, baseline!.plan, baseline!.display), [])
  // A connected device mid-save does not move the baseline; once idle it follows the saved plan.
  assert.deepEqual(nextInkBaseline(baseline, { connected: true, saving: true, plan: at5, display })?.plan, at15)
  assert.deepEqual(nextInkBaseline(baseline, { connected: true, saving: false, plan: at5, display })?.plan, at5)
})

test('a page opened while disconnected takes its baseline from the first saved state and waits for the display', () => {
  assert.equal(nextInkBaseline(undefined, { connected: false, saving: false, plan: DEFAULT_INK_PLAN }), undefined)
  const first = nextInkBaseline(undefined, { connected: false, saving: false, plan: DEFAULT_INK_PLAN, display: DEFAULT_DEVICE_DISPLAY })
  assert.deepEqual(first?.plan, DEFAULT_INK_PLAN)
  const other = selectInkPlan(DEFAULT_INK_PLAN, '30')
  assert.equal(nextInkBaseline(first, { connected: false, saving: false, plan: other, display: DEFAULT_DEVICE_DISPLAY }), first)
})

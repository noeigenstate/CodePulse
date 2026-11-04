import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampHudOrbPosition,
  defaultHudOrbPosition,
  hudOrbPositionForStage,
  hudStageForStyle,
  hudWindowBoundsForDisplay,
  type HudDisplay,
} from '../apps/desktop/src/main/hud-window.js'

const display: HudDisplay = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
}
const left: HudDisplay = {
  id: 2,
  bounds: { x: -1280, y: 100, width: 1280, height: 1024 },
  workArea: { x: -1280, y: 100, width: 1280, height: 984 },
}

test('panel stage preserves the original native geometry', () => {
  assert.deepEqual(hudStageForStyle('panel', display), {
    bounds: hudWindowBoundsForDisplay(display),
    stage: { style: 'panel', anchorH: 'right', anchorV: 'top' },
  })
})

for (const [style, x, width, height] of [
  ['island', 706, 508, 460],
  ['pills', 1532, 388, 720],
  ['edge', 1460, 460, 640],
] as const) {
  test(`${style} has its fixed stage and work-area placement`, () => {
    assert.deepEqual(hudStageForStyle(style, display).bounds, { x, y: 0, width, height })
    const negative = hudStageForStyle(style, left).bounds
    assert.equal(negative.y, left.workArea.y)
    assert.equal(negative.width, width)
    assert.ok(negative.x >= left.workArea.x)
    assert.ok(negative.x + width <= left.workArea.x + left.workArea.width)
  })
}

test('compact stages shrink to a smaller work area', () => {
  const small = { ...left, workArea: { x: -400, y: 50, width: 320, height: 240 } }
  for (const style of ['island', 'pills', 'edge', 'orb'] as const) {
    const { bounds, stage } = hudStageForStyle(style, small)
    assert.equal(bounds.width, 320)
    assert.equal(bounds.height, 240)
    if (style === 'orb') {
      const orb = hudOrbPositionForStage(bounds, stage)
      assert.ok(orb.x >= -392 && orb.x + 56 <= -88)
      assert.ok(orb.y >= 58 && orb.y + 56 <= 282)
    } else assert.deepEqual(bounds, small.workArea)
  }
})

test('default orb has a 48 px right gap and a 64 px top gap', () => {
  assert.deepEqual(defaultHudOrbPosition(display), { x: 1816, y: 64 })
  assert.deepEqual(defaultHudOrbPosition(left), { x: -104, y: 164 })
  const { bounds, stage } = hudStageForStyle('orb', display)
  assert.deepEqual(bounds, { x: 1448, y: 40, width: 448, height: 504 })
  assert.deepEqual(stage, { style: 'orb', anchorH: 'right', anchorV: 'top' })
})

for (const [x, y, anchorH, anchorV] of [
  [8, 8, 'left', 'top'],
  [1856, 8, 'right', 'top'],
  [8, 976, 'left', 'bottom'],
  [1856, 976, 'right', 'bottom'],
] as const) {
  test(`orb opens towards the centre from the ${anchorV}-${anchorH} corner`, () => {
    const { bounds, stage } = hudStageForStyle('orb', display, { x, y })
    assert.deepEqual(stage, { style: 'orb', anchorH, anchorV })
    assert.deepEqual(hudOrbPositionForStage(bounds, stage), { x, y })
    assert.equal(bounds.width, 448)
    assert.equal(bounds.height, 504)
    assert.ok(
      bounds.x < 0 ||
        bounds.y < 0 ||
        bounds.x + bounds.width > 1920 ||
        bounds.y + bounds.height > 1040,
    )
  })
}

test('orb clamping works in negative screen coordinates and does not mutate its input', () => {
  const position = Object.freeze({ x: -9999, y: 9999 })
  assert.deepEqual(clampHudOrbPosition(position, left), { x: -1272, y: 1020 })
  const { bounds, stage } = hudStageForStyle('orb', left, position)
  assert.deepEqual(hudOrbPositionForStage(bounds, stage), { x: -1272, y: 1020 })
  assert.deepEqual(position, { x: -9999, y: 9999 })
})

test('orb positions use whole DIP and invalid positions use the default', () => {
  assert.deepEqual(clampHudOrbPosition({ x: 100.4, y: 200.6 }, display), { x: 100, y: 201 })
  for (const position of [
    { x: NaN, y: 40 },
    { x: 40, y: Infinity },
  ]) {
    assert.deepEqual(hudStageForStyle('orb', display, position), hudStageForStyle('orb', display))
  }
})

for (const [width, height, y] of [
  [1280, 680, 320],
  [1366, 728, 340],
] as const) {
  test(`orb uses available room near the middle of a ${width}x${height} work area`, () => {
    const screen = {
      id: 3,
      bounds: { x: 100, y: -200, width, height },
      workArea: { x: 100, y: -200, width, height },
    }
    const position = { x: 100 + width - 120, y: -200 + y }
    const result = hudStageForStyle('orb', screen, position)
    assert.equal(result.stage.anchorV, 'top')
    assert.equal(result.stage.anchorH, 'right')
    assert.deepEqual(hudOrbPositionForStage(result.bounds, result.stage), position)
    assert.equal(
      hudStageForStyle('orb', screen, { ...position, y: -200 + height - y + 1 }).stage.anchorV,
      'bottom',
    )
  })
}

test('orb prefers opening below when all 480 DIP fit, then chooses the roomier side', () => {
  assert.equal(hudStageForStyle('orb', display, { x: 100, y: 560 }).stage.anchorV, 'top')
  assert.equal(hudStageForStyle('orb', display, { x: 100, y: 561 }).stage.anchorV, 'bottom')
})

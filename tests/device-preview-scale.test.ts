import assert from 'node:assert/strict'
import test from 'node:test'
import { deviceInspectScale, devicePixelRatioLabel, devicePreviewScale } from '@codepulse/shared'

const physical = (cssWidth: number, dpr: number) => Math.round(cssWidth * dpr * 1e6) / 1e6

test('preview takes the nearest whole physical multiple of 400 when it fits', () => {
  for (const [dpr, k, css] of [
    [1, 1, 400],
    [1.25, 1, 320],
    [1.5, 2, 800 / 1.5],
    [1.75, 2, 800 / 1.75],
    [2, 2, 400],
    [3, 3, 400],
  ] as const) {
    const scale = devicePreviewScale(dpr, 2000)
    assert.equal(scale.k, k, `dpr ${dpr}`)
    assert.ok(Math.abs(scale.cssWidth - css) < 1e-9, `dpr ${dpr}`)
    assert.equal(physical(scale.cssWidth, dpr), 400 * k, `dpr ${dpr} width`)
    assert.equal(physical(scale.cssHeight, dpr), 300 * k, `dpr ${dpr} height`)
  }
})

test('preview steps down to the largest whole multiple that fits, never below 1:1', () => {
  // dpr 1.5 wants 533 CSS px; 520 fits only 1:1 (267 CSS px).
  const narrow = devicePreviewScale(1.5, 520)
  assert.equal(narrow.k, 1)
  assert.ok(Math.abs(narrow.cssWidth - 400 / 1.5) < 1e-9)
  assert.equal(devicePreviewScale(1.5, 534).k, 2)
  assert.equal(devicePreviewScale(2, 399).k, 1)
  assert.equal(devicePreviewScale(2, 400).k, 2)
  // Too narrow even for 1:1: stay at 1:1 and let the frame scroll.
  const tiny = devicePreviewScale(1, 100)
  assert.equal(tiny.k, 1)
  assert.equal(tiny.cssWidth, 400)
  assert.equal(devicePreviewScale(0.75, 100).k, 1)
})

test('fill takes the largest whole multiple that fits', () => {
  assert.equal(devicePreviewScale(1.5, 866, true).k, 3)
  assert.equal(devicePreviewScale(1, 866, true).k, 2)
  assert.equal(devicePreviewScale(1, 300, true).k, 1)
  assert.equal(devicePreviewScale(1.5, Infinity, true).k, 2)
  assert.equal(devicePreviewScale(1.5, 2000, false, 341).k, 1, 'height cap')
  assert.equal(devicePreviewScale(1.5, 2000, false, 400).k, 2)
})

test('inspect view is at least 2x and in whole physical pixels', () => {
  for (const [dpr, k] of [
    [1, 2],
    [1.25, 3],
    [1.5, 3],
    [2, 4],
  ] as const) {
    const scale = deviceInspectScale(dpr)
    assert.equal(scale.k, k, `dpr ${dpr}`)
    assert.equal(physical(scale.cssWidth, dpr), 400 * k)
    assert.equal(physical(scale.cssHeight, dpr), 300 * k)
  }
})

test('bad pixel ratios read as 1 and the label tells the physical ratio', () => {
  for (const dpr of [0, -1, Number.NaN, Infinity]) assert.equal(devicePreviewScale(dpr, 2000).k, 1)
  assert.equal(devicePixelRatioLabel(2), '1:2 像素')
})

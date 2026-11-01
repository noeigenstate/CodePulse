import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { DEFAULT_DEVICE_DISPLAY } from '@codepulse/shared'
import { createDeviceRenderer as desktopRenderer } from '../apps/desktop/src/renderer/src/device-preview/renderer.mjs'
import { createDeviceRenderer as hudRenderer } from '../apps/hud/src/renderer/src/device-preview/renderer.mjs'
import { createDeviceDensityPreview as desktopFixture } from '../apps/desktop/src/renderer/src/components/device-density-preview.js'
import { createDeviceDensityPreview as hudFixture } from '../apps/hud/src/renderer/src/components/device-density-preview.js'

test('standard and HUD previews render identical production pixels for 3/6/9 tasks and usage', async () => {
  const desktopBytes = readFileSync('apps/desktop/src/renderer/src/device-preview/renderer.wasm')
  const hudBytes = readFileSync('apps/hud/src/renderer/src/device-preview/renderer.wasm')
  assert.deepEqual(desktopBytes, hudBytes)
  const desktop = await desktopRenderer(new Uint8Array(desktopBytes))
  const hud = await hudRenderer(new Uint8Array(hudBytes))
  for (const count of [3, 6, 9] as const) {
    for (const mode of ['hud', 'usage'] as const) {
      const config = { ...DEFAULT_DEVICE_DISPLAY, mode }
      const input = desktopFixture(config, count)
      assert.deepEqual(input, hudFixture(config, count))
      const frame = desktop(input)
      assert.equal(frame.length, 15000)
      assert.ok(frame.some(value => value !== 255), 'must contain ink')
      assert.deepEqual(frame, hud(input))
    }
  }
})

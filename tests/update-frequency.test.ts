import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UI_REFRESH_INTERVAL_MS } from '../apps/desktop/src/renderer/src/lib/timing.js'

test('renderer keeps derived realtime labels responsive', () => {
  assert.equal(UI_REFRESH_INTERVAL_MS, 500)
})

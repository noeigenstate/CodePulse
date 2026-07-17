import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UI_REFRESH_INTERVAL_MS } from '../apps/desktop/src/renderer/src/lib/timing.js'

test('renderer keeps derived realtime labels responsive', () => {
  // Shared useNow clock; 1s is enough for countdowns without N×500ms timers.
  assert.equal(UI_REFRESH_INTERVAL_MS, 1_000)
})

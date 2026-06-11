import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  STATUS_REFRESH_INTERVAL_MS,
  UI_REFRESH_INTERVAL_MS,
} from '../apps/desktop/src/renderer/src/lib/timing.js'

test('renderer refresh intervals keep the dashboard close to realtime', () => {
  assert.equal(UI_REFRESH_INTERVAL_MS, 500)
  assert.equal(STATUS_REFRESH_INTERVAL_MS, 1_000)
})

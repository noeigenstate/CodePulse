import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatDue } from '../apps/desktop/src/renderer/src/lib/dueText.js'

const NOW = new Date(2026, 10, 2, 14, 18).getTime()

test('reminders show day-relative wording and a fixed date format otherwise', () => {
  assert.equal(formatDue(new Date(2026, 10, 2, 18, 0).getTime(), NOW, 'zh'), '今天 18:00')
  assert.equal(formatDue(new Date(2026, 10, 3, 9, 5).getTime(), NOW, 'zh'), '明天 09:05')
  assert.equal(formatDue(new Date(2026, 10, 1, 8, 0).getTime(), NOW, 'zh'), '昨天 08:00')
  assert.equal(formatDue(new Date(2026, 10, 9, 9, 0).getTime(), NOW, 'zh'), '2026/11/09 09:00')
  assert.equal(formatDue(new Date(2026, 10, 2, 7, 0).getTime(), NOW, 'en'), 'Today 07:00')
})

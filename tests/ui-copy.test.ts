import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  headerCopy,
  nextLocale,
  overallLabel,
  turnStateLabel,
} from '../apps/desktop/src/renderer/src/lib/i18n.js'

test('header copy omits the old Chinese brand tag', () => {
  assert.equal(headerCopy('zh').brandTag, '')
  assert.equal(headerCopy('en').brandTag, '')
})

test('header copy does not expose a clear alerts action', () => {
  assert.equal('clearAlerts' in headerCopy('zh'), false)
  assert.equal('clearAlerts' in headerCopy('en'), false)
})

test('locale toggle switches between Chinese and English labels', () => {
  assert.equal(nextLocale('zh'), 'en')
  assert.equal(nextLocale('en'), 'zh')
  assert.equal(overallLabel('running', 'en'), 'Running')
  assert.equal(turnStateLabel(TurnState.DONE, 'en'), 'Done')
})

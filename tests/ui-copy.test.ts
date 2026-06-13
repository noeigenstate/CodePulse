import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  headerCopy,
  nextLocale,
  overallLabel,
  turnStateLabel,
  uiCopy,
} from '../apps/desktop/src/renderer/src/lib/i18n.js'
import { formatDuration, formatRelative } from '../apps/desktop/src/renderer/src/lib/format.js'
import {
  formatContextWindowStatus,
  formatProjectDirectoryBadge,
} from '../apps/desktop/src/renderer/src/lib/panelFormat.js'
import { formatQuotaReset } from '../apps/desktop/src/renderer/src/lib/quotaFormat.js'

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

test('Chinese locale does not expose English dashboard chrome', () => {
  const copy = uiCopy('zh')
  const text = [
    headerCopy('zh').subtitle,
    headerCopy('zh').languageToggle,
    copy.contextWindow,
    copy.waitingQuota,
    copy.unknownProject,
    formatContextWindowStatus(
      { accuracy: 'exact', contextUsedPercent: 79.85, contextWindow: 258_400, contextStale: true },
      undefined,
      copy.contextStatus,
    ).text,
    formatProjectDirectoryBadge(undefined, undefined, copy.pathStatus),
    formatDuration(62_000, 'zh'),
    formatRelative(1_000_000, 1_125_000, 'zh'),
    formatQuotaReset(1_000_005_400, 1_000_000_000_000, 'zh'),
  ].join(' ')

  assert.doesNotMatch(
    text,
    /\b(Context|window|left|used|last|waiting|project|directory|root|ago|refresh|Mute|Chinese)\b/i,
  )
})

test('English locale does not expose Chinese dashboard chrome', () => {
  const copy = uiCopy('en')
  const text = [
    headerCopy('en').subtitle,
    headerCopy('en').languageToggle,
    copy.contextWindow,
    copy.waitingQuota,
    copy.unknownProject,
    formatContextWindowStatus(
      { accuracy: 'exact', contextUsedPercent: 79.85, contextWindow: 258_400, contextStale: true },
      undefined,
      copy.contextStatus,
    ).text,
    formatProjectDirectoryBadge(undefined, undefined, copy.pathStatus),
    formatDuration(62_000, 'en'),
    formatRelative(1_000_000, 1_125_000, 'en'),
    formatQuotaReset(1_000_005_400, 1_000_000_000_000, 'en'),
  ].join(' ')

  assert.doesNotMatch(text, /[\u4e00-\u9fff]/)
})

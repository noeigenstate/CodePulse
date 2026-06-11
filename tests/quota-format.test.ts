import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokenQuotaNotice } from '@codepulse/shared'
import { formatQuotaDetail } from '../apps/desktop/src/renderer/src/lib/quotaFormat.js'

test('quota detail includes five-hour and weekly reset countdowns', () => {
  const now = 1_000_000_000_000
  const detail = formatQuotaDetail(
    {
      accuracy: 'estimated',
      rateLimits: {
        fiveHour: { usedPercent: 61, resetsAt: 1_000_005_400 },
        sevenDay: { usedPercent: 12, resetsAt: 1_000_561_600 },
      },
    },
    now,
  )

  assert.equal(detail, '5h 61% · 刷新 1h 30m / 每周 12% · 刷新 6d 12h')
})

test('quota detail keeps both windows visible when reset data is missing', () => {
  const detail = formatQuotaDetail({ accuracy: 'estimated', contextUsedPercent: 50 }, Date.now())

  assert.equal(detail, '5h — · 刷新 — / 每周 — · 刷新 —')
})

test('token quota notice includes five-hour and weekly reset countdowns', () => {
  const now = 1_000_000_000_000
  const notice = formatTokenQuotaNotice(
    'codex',
    {
      accuracy: 'estimated',
      contextUsedPercent: 50,
      rateLimits: {
        fiveHour: { usedPercent: 61, resetsAt: 1_000_005_400 },
        sevenDay: { usedPercent: 12, resetsAt: 1_000_561_600 },
      },
    },
    now,
  )

  assert.match(notice, /5h 61% · 刷新 1h 30m/)
  assert.match(notice, /每周 12% · 刷新 6d 12h/)
})

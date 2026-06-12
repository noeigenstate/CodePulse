import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokenCount, formatTokenQuotaNotice, formatTokenUsage } from '@codepulse/shared'
import {
  formatContextWindowStatus,
  formatWorkspaceLocation,
  visibleRateLimitWindows,
} from '../apps/desktop/src/renderer/src/lib/panelFormat.js'
import { formatQuotaDetail } from '../apps/desktop/src/renderer/src/lib/quotaFormat.js'

test('token counts use decimal M as one million tokens', () => {
  assert.equal(formatTokenCount(1_000_000), '1M')
  assert.equal(formatTokenCount(1_250_000), '1.25M')
  assert.equal(formatTokenUsage({ accuracy: 'estimated', total: 1_000_000 }), '总计 1M token')
})

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

test('token quota notice omits raw token breakdowns', () => {
  const notice = formatTokenQuotaNotice('codex', {
    accuracy: 'estimated',
    input: 108_000_000,
    cachedInput: 103_000_000,
    output: 363_000,
    reasoningOutput: 123_000,
    total: 108_900_000,
    contextUsedPercent: 80,
    contextWindow: 258_400,
  })

  assert.doesNotMatch(notice, /输入|缓存|输出|推理|总计/)
})

test('context window status mirrors the compact Codex slash display', () => {
  const status = formatContextWindowStatus({
    accuracy: 'estimated',
    contextUsedPercent: 79.85,
    contextWindow: 258_400,
  })

  assert.equal(status.usedPercent, 79.85)
  assert.equal(status.text, '21% left (207K used / 258K)')
})

test('zero-only quota snapshots are treated as unavailable display data', () => {
  const windows = visibleRateLimitWindows({
    accuracy: 'estimated',
    rateLimits: {
      fiveHour: { usedPercent: 0 },
      sevenDay: { usedPercent: 0 },
    },
  })

  assert.equal(windows.fiveHour, undefined)
  assert.equal(windows.sevenDay, undefined)
})

test('zero quota snapshots with reset metadata are visible', () => {
  const windows = visibleRateLimitWindows({
    accuracy: 'estimated',
    rateLimits: {
      fiveHour: { usedPercent: 0, resetsAt: 1_000_000, windowMinutes: 300 },
      sevenDay: { usedPercent: 0, resetsAt: 2_000_000, windowMinutes: 10_080 },
    },
  })

  assert.equal(windows.fiveHour?.usedPercent, 0)
  assert.equal(windows.fiveHour?.resetsAt, 1_000_000)
  assert.equal(windows.sevenDay?.usedPercent, 0)
  assert.equal(windows.sevenDay?.resetsAt, 2_000_000)
})

test('workspace paths are shortened for project rows', () => {
  assert.equal(
    formatWorkspaceLocation('E:\\不负芳华\\CodePulse\\desktop'),
    '... / CodePulse / desktop',
  )
})

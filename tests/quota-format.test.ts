import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatTokenCount, formatTokenQuotaNotice, formatTokenUsage } from '@codepulse/shared'
import {
  formatContextWindowStatus,
  formatProjectDirectoryBadge,
  formatWorkspaceLocation,
  visibleRateLimitWindows,
} from '../apps/desktop/src/renderer/src/lib/panelFormat.js'
import { formatQuotaDetail } from '../apps/desktop/src/renderer/src/lib/quotaFormat.js'

test('token counts use decimal M as one million tokens', () => {
  assert.equal(formatTokenCount(1_000_000), '1M')
  assert.equal(formatTokenCount(1_250_000), '1.25M')
  assert.equal(formatTokenUsage({ accuracy: 'estimated', total: 1_000_000 }), '总计 1M token')
})

test('quota detail includes five-hour and weekly reset countdowns for Claude', () => {
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
    'zh',
    'claude_code',
  )

  assert.equal(detail, '5 小时 61% · 刷新 1 小时 30 分 / 每周 12% · 刷新 6 天 12 小时')
})

test('quota detail hides five-hour window for Codex and Grok', () => {
  const now = 1_000_000_000_000
  const token = {
    accuracy: 'estimated' as const,
    rateLimits: {
      fiveHour: { usedPercent: 61, resetsAt: 1_000_005_400 },
      sevenDay: { usedPercent: 12, resetsAt: 1_000_561_600 },
    },
  }

  assert.equal(formatQuotaDetail(token, now, 'zh', 'codex'), '每周 12% · 刷新 6 天 12 小时')
  assert.equal(formatQuotaDetail(token, now, 'zh', 'grok'), '每周 12% · 刷新 6 天 12 小时')
})

test('quota detail keeps weekly window visible when reset data is missing', () => {
  const detail = formatQuotaDetail(
    { accuracy: 'estimated', contextUsedPercent: 50 },
    Date.now(),
    'zh',
    'codex',
  )

  assert.equal(detail, '每周 — · 刷新 —')
})

test('token quota notice is weekly-only for Codex', () => {
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

  assert.doesNotMatch(notice, /5h/)
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

test('stale context window status is labelled as last snapshot', () => {
  const status = formatContextWindowStatus({
    accuracy: 'exact',
    contextUsedPercent: 79.85,
    contextWindow: 258_400,
    contextStale: true,
  })

  assert.equal(status.usedPercent, 79.85)
  assert.equal(status.stale, true)
  assert.equal(status.text, 'last: 21% left (207K used / 258K)')
})

test('zero-only quota snapshots are treated as unavailable display data', () => {
  const windows = visibleRateLimitWindows(
    {
      accuracy: 'estimated',
      rateLimits: {
        fiveHour: { usedPercent: 0 },
        sevenDay: { usedPercent: 0 },
      },
    },
    'claude_code',
  )

  assert.equal(windows.fiveHour, undefined)
  assert.equal(windows.sevenDay, undefined)
})

test('zero quota snapshots with reset metadata are visible as refreshed quota data', () => {
  const windows = visibleRateLimitWindows(
    {
      accuracy: 'estimated',
      rateLimits: {
        fiveHour: { usedPercent: 0, resetsAt: 1_000_000, windowMinutes: 300 },
        sevenDay: { usedPercent: 0, resetsAt: 2_000_000, windowMinutes: 10_080 },
      },
    },
    'claude_code',
  )

  assert.equal(windows.fiveHour?.usedPercent, 0)
  assert.equal(windows.sevenDay?.usedPercent, 0)
})

test('Codex and Grok visible windows omit five-hour even when payload has it', () => {
  const token = {
    accuracy: 'estimated' as const,
    rateLimits: {
      fiveHour: { usedPercent: 40, resetsAt: 1_000_000, windowMinutes: 300 },
      sevenDay: { usedPercent: 15, resetsAt: 2_000_000, windowMinutes: 10_080 },
    },
  }

  assert.equal(visibleRateLimitWindows(token, 'codex').fiveHour, undefined)
  assert.equal(visibleRateLimitWindows(token, 'codex').sevenDay?.usedPercent, 15)
  assert.equal(visibleRateLimitWindows(token, 'grok').fiveHour, undefined)
  assert.equal(visibleRateLimitWindows(token, 'claude_code').fiveHour?.usedPercent, 40)
})

test('workspace paths are shortened for project rows', () => {
  assert.equal(formatWorkspaceLocation('C:\\code\\CodePulse\\desktop'), '... / CodePulse / desktop')
})

test('project directory badge omits the duplicated project title segment', () => {
  assert.equal(
    formatProjectDirectoryBadge('C:\\work\\projects\\CodePulse\\desktop', 'desktop'),
    '... / projects / CodePulse',
  )
})

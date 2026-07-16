import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  mergeClaudeContextWithQuota,
  normalizeClaudeRateLimitsPayload,
  readClaudeQuotaCache,
  writeClaudeQuotaCache,
} from '@codepulse/local-server'

test('normalizeClaudeRateLimitsPayload maps utilization 0-1 and ISO resets_at', () => {
  const fiveReset = new Date(Date.now() + 3 * 60 * 60_000).toISOString()
  const weekReset = new Date(Date.now() + 4 * 24 * 60 * 60_000).toISOString()
  const limits = normalizeClaudeRateLimitsPayload({
    five_hour: {
      utilization: 0.12,
      resets_at: fiveReset,
    },
    seven_day_opus: {
      utilization: 0.34,
      resets_at: weekReset,
    },
  })
  assert.equal(limits?.fiveHour?.usedPercent, 12)
  assert.equal(limits?.sevenDay?.usedPercent, 34)
  assert.ok((limits?.fiveHour?.resetsAt ?? 0) > Date.now() / 1000)
  // Far-future placeholders must be dropped (would render as "2498 天").
  const bogus = normalizeClaudeRateLimitsPayload({
    five_hour: { used_percent: 5, resets_at: 2_000_000_000 },
  })
  assert.equal(bogus?.fiveHour?.usedPercent, 5)
  assert.equal(bogus?.fiveHour?.resetsAt, undefined)
})

test('normalizeClaudeRateLimitsPayload keeps 0-100 used_percentage', () => {
  const limits = normalizeClaudeRateLimitsPayload({
    five_hour: { used_percentage: 45, resets_at: 2_000_000_000 },
    seven_day: { used_percent: 18, resets_at: 2_100_000_000 },
  })
  assert.equal(limits?.fiveHour?.usedPercent, 45)
  assert.equal(limits?.sevenDay?.usedPercent, 18)
})

test('normalizeClaudeRateLimitsPayload prefers model-family weekly window', () => {
  const families = {
    five_hour: { used_percent: 10, resets_at: Math.floor(Date.now() / 1000) + 3_600 },
    seven_day: { used_percent: 50, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
    seven_day_opus: { used_percent: 88, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
    seven_day_sonnet: { used_percent: 12, resets_at: Math.floor(Date.now() / 1000) + 86_400 },
  }
  assert.equal(
    normalizeClaudeRateLimitsPayload(families, 'claude-opus-4')?.sevenDay?.usedPercent,
    88,
  )
  assert.equal(
    normalizeClaudeRateLimitsPayload(families, 'claude-sonnet-4')?.sevenDay?.usedPercent,
    12,
  )
  // No model → generic overall week when present.
  assert.equal(normalizeClaudeRateLimitsPayload(families)?.sevenDay?.usedPercent, 50)
})

test('mergeClaudeContextWithQuota re-picks weekly window from rawFamilies', () => {
  const quota = {
    rateLimits: {
      fiveHour: { usedPercent: 10 },
      sevenDay: { usedPercent: 50 },
    },
    rateLimitId: 'claude',
    updatedAt: Date.now(),
    source: 'oauth' as const,
    rawFamilies: {
      five_hour: { used_percent: 10 },
      seven_day: { used_percent: 50 },
      seven_day_opus: { used_percent: 77 },
      seven_day_sonnet: { used_percent: 9 },
    },
  }
  const opus = mergeClaudeContextWithQuota(
    { accuracy: 'estimated', contextUsedPercent: 20 },
    quota,
    'claude-opus-4-1',
  )
  const sonnet = mergeClaudeContextWithQuota(
    { accuracy: 'estimated', contextUsedPercent: 20 },
    quota,
    'claude-sonnet-4',
  )
  assert.equal(opus.rateLimits?.sevenDay?.usedPercent, 77)
  assert.equal(sonnet.rateLimits?.sevenDay?.usedPercent, 9)
})

test('claude quota cache round-trips for session-sync merge', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-claude-quota-'))
  try {
    await mkdir(join(home, '.codepulse'), { recursive: true })
    await writeClaudeQuotaCache(
      {
        rateLimits: {
          fiveHour: { usedPercent: 7, resetsAt: 2_000_000_000, windowMinutes: 300 },
          sevenDay: { usedPercent: 21, resetsAt: 2_100_000_000, windowMinutes: 10_080 },
        },
        rateLimitId: 'claude',
        rateLimitName: 'Claude pro',
        source: 'statusline',
      },
      home,
      Date.now(),
    )

    const cached = await readClaudeQuotaCache(home, Date.now())
    assert.equal(cached?.rateLimits.fiveHour?.usedPercent, 7)
    assert.equal(cached?.rateLimits.sevenDay?.usedPercent, 21)

    const merged = mergeClaudeContextWithQuota(
      { accuracy: 'estimated', contextUsedPercent: 33, contextWindow: 200_000 },
      cached,
    )
    assert.equal(merged.contextUsedPercent, 33)
    assert.equal(merged.rateLimits?.fiveHour?.usedPercent, 7)
    assert.equal(merged.rateLimits?.sevenDay?.usedPercent, 21)
    assert.equal(merged.rateLimitName, 'Claude pro')

    const raw = JSON.parse(await readFile(join(home, '.codepulse', 'claude-quota.json'), 'utf8'))
    assert.equal(raw.rate_limits.five_hour.used_percent, 7)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

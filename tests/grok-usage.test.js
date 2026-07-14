import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { readLatestGrokUsage } from '../packages/hooks/lib/grok-usage.js'

test('Grok usage reader extracts context from signals.json and weekly credits from billing log', async () => {
  const home = join(tmpdir(), `codepulse-grok-${Date.now()}`)
  const cwd = 'E:\\project\\demo'
  const sessionId = '019f0000-aaaa-bbbb-cccc-ddddeeeeffff'
  const sessionDir = join(home, 'sessions', encodeURIComponent(cwd), sessionId)
  const logsDir = join(home, 'logs')

  await mkdir(sessionDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })

  await writeFile(
    join(sessionDir, 'signals.json'),
    JSON.stringify({
      contextWindowUsage: 12,
      contextTokensUsed: 60000,
      contextWindowTokens: 500000,
      primaryModelId: 'grok-4.5',
      modelsUsed: ['grok-4.5'],
    }),
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'summary.json'),
    JSON.stringify({
      info: { id: sessionId, cwd },
      current_model_id: 'grok-4.5',
    }),
    'utf8',
  )

  const periodEnd = '2026-07-16T05:46:37.819944+00:00'
  await writeFile(
    join(logsDir, 'unified.jsonl'),
    [
      JSON.stringify({
        ts: '2026-07-09T01:00:00.000Z',
        msg: 'noise',
        ctx: {},
      }),
      JSON.stringify({
        ts: '2026-07-09T06:35:02.600Z',
        msg: 'billing: fetched credits config',
        ctx: {
          config: {
            creditUsagePercent: 17.5,
            currentPeriod: {
              type: 'USAGE_PERIOD_TYPE_WEEKLY',
              start: '2026-07-09T05:46:37.819944+00:00',
              end: periodEnd,
            },
            billingPeriodEnd: periodEnd,
          },
          subscriptionTier: 'SuperGrok',
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestGrokUsage({ session_id: sessionId, cwd }, { grokHome: home })

    assert.equal(usage.model, 'grok-4.5')
    assert.equal(usage.context_window_size, 500000)
    assert.equal(usage.context_used_percent, 12)
    assert.deepEqual(usage.usage, {
      input_tokens: 60000,
      total_tokens: 60000,
    })
    assert.equal(usage.rate_limits.seven_day.used_percentage, 17.5)
    assert.equal(usage.rate_limits.seven_day.resets_at, Math.floor(Date.parse(periodEnd) / 1000))
    assert.equal(usage.rate_limits.seven_day.window_minutes, 7 * 24 * 60)
    assert.equal(usage.rate_limit_name, 'SuperGrok')
    assert.ok(String(usage.usage_source_path).includes('signals.json'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Grok usage reader finds session via active_sessions when payload only has cwd', async () => {
  const home = join(tmpdir(), `codepulse-grok-active-${Date.now()}`)
  const cwd = 'D:/work/app'
  const sessionId = '019f1111-aaaa-bbbb-cccc-ddddeeeeffff'
  const sessionDir = join(home, 'sessions', encodeURIComponent(cwd), sessionId)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(home, 'active_sessions.json'),
    JSON.stringify([
      {
        session_id: sessionId,
        cwd,
        opened_at: '2026-07-09T06:00:00.000Z',
      },
    ]),
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'signals.json'),
    JSON.stringify({
      contextWindowUsage: 3,
      contextTokensUsed: 15000,
      contextWindowTokens: 500000,
      primaryModelId: 'grok-4.5',
    }),
    'utf8',
  )

  try {
    const usage = await readLatestGrokUsage({ cwd }, { grokHome: home })
    assert.equal(usage.context_used_percent, 3)
    assert.equal(usage.model, 'grok-4.5')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Grok usage reader returns empty object when no local data exists', async () => {
  const home = join(tmpdir(), `codepulse-grok-empty-${Date.now()}`)
  await mkdir(home, { recursive: true })
  try {
    const usage = await readLatestGrokUsage(
      { session_id: 'missing', cwd: 'E:/nope' },
      { grokHome: home },
    )
    assert.deepEqual(usage, {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Grok usage reader uses updates.jsonl live context when signals.json is absent', async () => {
  const home = join(tmpdir(), `codepulse-grok-live-${Date.now()}`)
  const cwd = 'E:\\work\\active-session'
  const sessionId = '019f2222-aaaa-bbbb-cccc-ddddeeeeffff'
  const sessionDir = join(home, 'sessions', encodeURIComponent(cwd), sessionId)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(sessionDir, 'summary.json'),
    JSON.stringify({
      info: { id: sessionId, cwd },
      current_model_id: 'grok-4.5',
    }),
    'utf8',
  )
  // Active turn: only summary + updates (no signals.json yet).
  // Earlier higher totalTokens must NOT win — context can shrink after compression.
  await writeFile(
    join(sessionDir, 'updates.jsonl'),
    [
      JSON.stringify({
        type: 'status',
        params: { _meta: { totalTokens: 200000 }, model: 'grok-4.5' },
      }),
      JSON.stringify({
        type: 'turn_completed',
        params: {
          // Cumulative model-call volume — must be ignored for context.
          usage: { totalTokens: 999999 },
        },
      }),
      JSON.stringify({
        type: 'status',
        params: { _meta: { totalTokens: 115254 }, model: 'grok-4.5' },
      }),
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    join(home, 'models_cache.json'),
    JSON.stringify({
      models: [
        {
          id: 'grok-4.5',
          context_window: 500000,
        },
      ],
    }),
    'utf8',
  )

  try {
    const usage = await readLatestGrokUsage({ session_id: sessionId, cwd }, { grokHome: home })

    assert.equal(usage.model, 'grok-4.5')
    assert.equal(usage.usage?.total_tokens, 115254, 'must use last _meta.totalTokens, not max')
    assert.equal(usage.context_window_size, 500000)
    assert.ok(
      Math.abs(Number(usage.context_used_percent) - (115254 / 500000) * 100) < 0.01,
      `expected ~23% context, got ${usage.context_used_percent}`,
    )
    assert.ok(String(usage.usage_source_path).includes('updates.jsonl'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Grok usage reader prefers signals.json over updates.jsonl when both exist', async () => {
  const home = join(tmpdir(), `codepulse-grok-signals-pref-${Date.now()}`)
  const cwd = 'E:\\work\\done-session'
  const sessionId = '019f3333-aaaa-bbbb-cccc-ddddeeeeffff'
  const sessionDir = join(home, 'sessions', encodeURIComponent(cwd), sessionId)

  await mkdir(sessionDir, { recursive: true })
  await writeFile(
    join(sessionDir, 'summary.json'),
    JSON.stringify({ info: { id: sessionId, cwd }, current_model_id: 'grok-4.5' }),
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'updates.jsonl'),
    JSON.stringify({
      type: 'status',
      params: { _meta: { totalTokens: 99999 }, model: 'grok-4.5' },
    }) + '\n',
    'utf8',
  )
  await writeFile(
    join(sessionDir, 'signals.json'),
    JSON.stringify({
      contextWindowUsage: 23,
      contextTokensUsed: 115254,
      contextWindowTokens: 500000,
      primaryModelId: 'grok-4.5',
    }),
    'utf8',
  )

  try {
    const usage = await readLatestGrokUsage({ session_id: sessionId, cwd }, { grokHome: home })
    assert.equal(usage.context_used_percent, 23)
    assert.equal(usage.usage?.total_tokens, 115254)
    assert.ok(String(usage.usage_source_path).includes('signals.json'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

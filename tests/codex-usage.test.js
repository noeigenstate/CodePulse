import assert from 'node:assert/strict'
import { mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { readLatestCodexUsage } from '../packages/hooks/lib/codex-usage.js'

test('Codex usage reader extracts latest token_count from rollout JSONL', async () => {
  const home = join(tmpdir(), `codepulse-codex-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const sessionId = 'session-abc'
  const rollout = join(sessions, `rollout-2026-06-11T10-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        timestamp: '2026-06-11T02:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          turn_id: 'turn-1',
          model_context_window: 200000,
        },
      }),
      JSON.stringify({
        timestamp: '2026-06-11T02:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200000,
            total_token_usage: {
              input_tokens: 12000,
              cached_input_tokens: 3000,
              output_tokens: 700,
              reasoning_output_tokens: 50,
              total_tokens: 12700,
            },
            last_token_usage: {
              input_tokens: 2000,
              cached_input_tokens: 500,
              output_tokens: 100,
              reasoning_output_tokens: 25,
              total_tokens: 2100,
            },
          },
          rate_limits: {
            primary: { used_percent: 34, window_minutes: 300, resets_at: 1781160358 },
            secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1781747174 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ session_id: sessionId }, { codexHome: home })
    assert.equal(usage.usage_source_path, rollout)
    assert.deepEqual(usage, {
      usage: {
        input_tokens: 12000,
        cached_input_tokens: 3000,
        output_tokens: 700,
        reasoning_output_tokens: 50,
        total_tokens: 12700,
      },
      context_usage: {
        input_tokens: 2000,
        cached_input_tokens: 500,
        output_tokens: 100,
        reasoning_output_tokens: 25,
        total_tokens: 2100,
      },
      context_window_size: 200000,
      context_used_percent: 1,
      rate_limits: {
        five_hour: { used_percentage: 34, resets_at: 1781160358, window_minutes: 300 },
        seven_day: { used_percentage: 5, resets_at: 1781747174, window_minutes: 10080 },
      },
      usage_source_path: rollout,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader prefers the rollout matching current cwd', async () => {
  const home = join(tmpdir(), `codepulse-codex-cwd-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const target = join(sessions, 'rollout-2026-06-11T10-00-00-target.jsonl')
  const other = join(sessions, 'rollout-2026-06-11T10-01-00-other.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    target,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'target', cwd: 'E:/project/target' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 4000, output_tokens: 500, total_tokens: 4500 },
            last_token_usage: { input_tokens: 2000, output_tokens: 250, total_tokens: 2250 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    other,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'other', cwd: 'E:/project/other' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 90000, output_tokens: 500, total_tokens: 90500 },
            last_token_usage: { input_tokens: 80000, output_tokens: 250, total_tokens: 80250 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(target, new Date('2026-06-11T02:00:00Z'), new Date('2026-06-11T02:00:00Z'))
  await utimes(other, new Date('2026-06-11T02:05:00Z'), new Date('2026-06-11T02:05:00Z'))

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/target' }, { codexHome: home })
    assert.equal(usage.usage.total_tokens, 4500)
    assert.equal(usage.context_used_percent, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader prefers session id over cwd when model sessions share a project', async () => {
  const home = join(tmpdir(), `codepulse-codex-session-first-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const current = join(sessions, 'rollout-2026-06-11T10-00-00-session-gpt55.jsonl')
  const other = join(sessions, 'rollout-2026-06-11T10-01-00-session-spark.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    current,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-gpt55', cwd: 'E:/project/shared' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 5500, output_tokens: 500, total_tokens: 6000 },
            last_token_usage: { input_tokens: 3000, output_tokens: 250, total_tokens: 3250 },
          },
          rate_limits: {
            primary: { used_percent: 55, window_minutes: 300, resets_at: 1781160358 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    other,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-spark', cwd: 'E:/project/shared' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 5300, output_tokens: 400, total_tokens: 5700 },
            last_token_usage: { input_tokens: 2000, output_tokens: 150, total_tokens: 2150 },
          },
          rate_limits: {
            primary: { used_percent: 3, window_minutes: 300, resets_at: 1781160358 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await utimes(current, new Date('2026-06-11T02:00:00Z'), new Date('2026-06-11T02:00:00Z'))
  await utimes(other, new Date('2026-06-11T02:05:00Z'), new Date('2026-06-11T02:05:00Z'))

  try {
    const usage = await readLatestCodexUsage(
      { session_id: 'session-gpt55', cwd: 'E:/project/shared' },
      { codexHome: home },
    )
    assert.equal(usage.usage.total_tokens, 6000)
    assert.equal(usage.rate_limits.five_hour.used_percentage, 55)
    assert.equal(usage.usage_source_path, current)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader does not double count cached input for context percent', async () => {
  const home = join(tmpdir(), `codepulse-codex-context-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-context.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'context', cwd: 'E:/project/context' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 200000,
            total_token_usage: {
              input_tokens: 120000,
              cached_input_tokens: 90000,
              output_tokens: 1000,
              total_tokens: 121000,
            },
            last_token_usage: {
              input_tokens: 100000,
              cached_input_tokens: 90000,
              output_tokens: 1000,
              total_tokens: 101000,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/context' }, { codexHome: home })
    assert.equal(usage.context_used_percent, 50)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader parses 1M context window strings as one million tokens', async () => {
  const home = join(tmpdir(), `codepulse-codex-window-unit-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-window-unit.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'window-unit', cwd: 'E:/project/window-unit' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: '1M',
            total_token_usage: { input_tokens: 250000, output_tokens: 1000, total_tokens: 251000 },
            last_token_usage: { input_tokens: 250000, output_tokens: 1000, total_tokens: 251000 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/window-unit' }, { codexHome: home })
    assert.equal(usage.context_window_size, 1_000_000)
    assert.equal(usage.context_used_percent, 25)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader scans newer session folders before capped history', async () => {
  const home = join(tmpdir(), `codepulse-codex-cap-${Date.now()}`)
  const oldSessions = join(home, 'sessions', '2025', '01', '01')
  const freshSessions = join(home, 'sessions', '2026', '06', '11')
  const fresh = join(freshSessions, 'rollout-2026-06-11T10-00-00-fresh.jsonl')

  await mkdir(oldSessions, { recursive: true })
  await mkdir(freshSessions, { recursive: true })

  const oldPayload = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'old', cwd: 'E:/project/old' } }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 100000,
          total_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
          last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
        },
      },
    }),
  ].join('\n')
  await Promise.all(
    Array.from({ length: 510 }, (_, i) =>
      writeFile(
        join(oldSessions, `rollout-2025-01-01T00-00-${String(i).padStart(3, '0')}.jsonl`),
        oldPayload,
        'utf8',
      ),
    ),
  )
  await writeFile(
    fresh,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'fresh', cwd: 'E:/project/fresh' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 4200, output_tokens: 300, total_tokens: 4500 },
            last_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/fresh' }, { codexHome: home })
    assert.equal(usage.usage.total_tokens, 4500)
    assert.equal(usage.context_used_percent, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader does not fall back to another project when cwd is known', async () => {
  const home = join(tmpdir(), `codepulse-codex-no-fallback-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const other = join(sessions, 'rollout-2026-06-11T10-01-00-other.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    other,
    [
      JSON.stringify({ type: 'session_meta', payload: { id: 'other', cwd: 'E:/project/other' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 90000, output_tokens: 500, total_tokens: 90500 },
            last_token_usage: { input_tokens: 80000, output_tokens: 250, total_tokens: 80250 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/missing' }, { codexHome: home })
    assert.deepEqual(usage, {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader falls back to 256k context window', async () => {
  const home = join(tmpdir(), `codepulse-codex-window-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-default-window.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'default-window', cwd: 'E:/project/default-window' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
            last_token_usage: { input_tokens: 2560, output_tokens: 100, total_tokens: 2660 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage(
      { cwd: 'E:/project/default-window' },
      { codexHome: home },
    )
    assert.equal(usage.context_window_size, 256000)
    assert.equal(usage.context_used_percent, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader accepts rate limits under info', async () => {
  const home = join(tmpdir(), `codepulse-codex-info-rate-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-info-rate.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'info-rate', cwd: 'E:/project/info-rate' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            total_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
            last_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
            rate_limits: {
              primary: { used_percent: 57, window_minutes: 300, resets_at: 1781160358 },
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ cwd: 'E:/project/info-rate' }, { codexHome: home })
    assert.equal(usage.rate_limits.five_hour.used_percentage, 57)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader ignores stale transcript_path after fork when model is non-Spark', async () => {
  const home = join(tmpdir(), `codepulse-codex-stale-transcript-${Date.now()}`)
  const day = join(home, 'sessions', '2026', '07', '14')
  const parentId = '019f593c-aaaa-bbbb-cccc-parent00000001'
  const forkId = '019f5fbb-dddd-eeee-ffff-fork0000000001'
  const cwd = 'C:\\Users\\Administrator\\Desktop\\MetalMax_recovered_from_recycle_bin_20260708'
  const parentFile = join(day, `rollout-2026-07-12T22-08-56-${parentId}.jsonl`)
  const forkFile = join(day, `rollout-2026-07-14T04-25-22-${forkId}.jsonl`)

  await mkdir(day, { recursive: true })
  await writeFile(
    parentFile,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: parentId, cwd, timestamp: '2026-07-12T22:08:56.000Z' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
          },
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 0, window_minutes: 10080, resets_at: 1784623806 },
            secondary: null,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    forkFile,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { session_id: parentId, id: forkId, forked_from_id: parentId },
      }),
      JSON.stringify({
        type: 'session_meta',
        payload: { id: parentId, cwd, timestamp: '2026-07-13T02:08:56.000Z' },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd, turn_id: 'turn-live' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: { input_tokens: 90000, output_tokens: 200, total_tokens: 90200 },
          },
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: 49, window_minutes: 10080, resets_at: 1784513490 },
            secondary: null,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  const now = Date.now()
  await utimes(parentFile, new Date(now - 30_000), new Date(now - 30_000))
  await utimes(forkFile, new Date(now), new Date(now))

  try {
    // Real fork/resume hook shape: stale transcript_path + live session + non-Spark model.
    const usage = await readLatestCodexUsage(
      {
        transcript_path: parentFile,
        session_id: forkId,
        cwd,
        model: 'gpt-5.6-sol',
      },
      { codexHome: home },
    )

    assert.equal(usage.rate_limit_id, 'codex')
    assert.equal(usage.rate_limit_name, undefined)
    assert.deepEqual(usage.rate_limits?.seven_day, {
      used_percentage: 49,
      resets_at: 1784513490,
      window_minutes: 10080,
    })
    assert.equal(usage.usage_source_path, forkFile)
    assert.doesNotMatch(String(usage.rate_limit_id ?? ''), /bengalfox|spark/i)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader resolves forked session meta and prefers main weekly over idle Spark', async () => {
  const home = join(tmpdir(), `codepulse-codex-fork-cwd-${Date.now()}`)
  const day = join(home, 'sessions', '2026', '07', '14')
  const parentId = '019f593c-1113-74f1-9526-c85e36f84960'
  const forkId = '019f5fbb-0d51-7123-853b-619eb792f316'
  const cwd = 'C:\\Users\\Administrator\\Desktop\\MetalMax_recovered_from_recycle_bin_20260708'
  const parentFile = join(day, `rollout-2026-07-12T22-08-56-${parentId}.jsonl`)
  const forkFile = join(day, `rollout-2026-07-14T04-25-22-${forkId}.jsonl`)

  await mkdir(day, { recursive: true })
  // Older parent session: Spark bucket at 0% (must not win for cwd lookup).
  await writeFile(
    parentFile,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: parentId, cwd, timestamp: '2026-07-12T22:08:56.000Z' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
          },
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 0, window_minutes: 10080, resets_at: 1784623806 },
            secondary: null,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  // Forked active session: first meta has no cwd (Codex fork header), second carries cwd.
  await writeFile(
    forkFile,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: parentId,
          id: forkId,
          forked_from_id: parentId,
          timestamp: '2026-07-14T04:25:22.000Z',
        },
      }),
      JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: parentId,
          id: parentId,
          cwd,
          timestamp: '2026-07-13T02:08:56.000Z',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { cwd, turn_id: 'turn-1' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258400,
            last_token_usage: { input_tokens: 70000, output_tokens: 100, total_tokens: 70100 },
          },
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: { used_percent: 47, window_minutes: 10080, resets_at: 1784513490 },
            secondary: null,
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  // Make fork file appear newer for mtime-based ranking.
  const now = Date.now()
  await utimes(parentFile, new Date(now - 60_000), new Date(now - 60_000))
  await utimes(forkFile, new Date(now), new Date(now))

  try {
    const byCwd = await readLatestCodexUsage({ cwd }, { codexHome: home })
    assert.equal(byCwd.rate_limit_id, 'codex')
    assert.deepEqual(byCwd.rate_limits?.seven_day, {
      used_percentage: 47,
      resets_at: 1784513490,
      window_minutes: 10080,
    })
    assert.match(byCwd.usage_source_path ?? '', new RegExp(forkId))

    const bySession = await readLatestCodexUsage({ session_id: forkId }, { codexHome: home })
    assert.equal(bySession.rate_limits?.seven_day?.used_percentage, 47)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader keeps quota from an earlier token_count when the latest only has context', async () => {
  const home = join(tmpdir(), `codepulse-codex-quota-stale-context-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const sessionId = 'session-quota-stale'
  const rollout = join(sessions, `rollout-2026-07-14T10-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd: 'E:/project/quota-stale' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'task_started',
          model_context_window: 256000,
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 },
          },
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: {
              used_percent: 43,
              window_minutes: 10080,
              resets_at: 1784513490,
            },
            secondary: null,
          },
        },
      }),
      // Later token_count updates context only — must not wipe weekly quota.
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 80000, output_tokens: 200, total_tokens: 80200 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ session_id: sessionId }, { codexHome: home })
    assert.ok(usage.context_used_percent > 30)
    assert.deepEqual(usage.rate_limits?.seven_day, {
      used_percentage: 43,
      resets_at: 1784513490,
      window_minutes: 10080,
    })
    assert.equal(usage.rate_limit_id, 'codex')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader maps weekly-only primary rate limit to seven_day', async () => {
  const home = join(tmpdir(), `codepulse-codex-weekly-only-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '07', '12')
  const sessionId = 'session-weekly-only'
  const rollout = join(sessions, `rollout-2026-07-12T22-00-00-${sessionId}.jsonl`)

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        timestamp: '2026-07-12T14:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_started',
          model_context_window: 353400,
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-12T14:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 353400,
            last_token_usage: {
              input_tokens: 1000,
              output_tokens: 50,
              total_tokens: 1050,
            },
          },
          rate_limits: {
            limit_id: 'codex',
            limit_name: null,
            primary: {
              used_percent: 2,
              window_minutes: 10080,
              resets_at: 1784513490,
            },
            secondary: null,
            plan_type: 'prolite',
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage({ session_id: sessionId }, { codexHome: home })
    assert.equal(usage.rate_limits?.five_hour, undefined)
    assert.deepEqual(usage.rate_limits?.seven_day, {
      used_percentage: 2,
      resets_at: 1784513490,
      window_minutes: 10080,
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage reader exposes quota bucket identity from rollout rate limits', async () => {
  const home = join(tmpdir(), `codepulse-codex-rate-identity-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-rate-identity.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'rate-identity', cwd: 'E:/project/rate-identity' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            total_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
            last_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
          },
          rate_limits: {
            limit_id: 'codex_bengalfox',
            limit_name: 'GPT-5.3-Codex-Spark',
            primary: { used_percent: 2, window_minutes: 300, resets_at: 1781160358 },
            secondary: { used_percent: 1, window_minutes: 10080, resets_at: 1781747174 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const usage = await readLatestCodexUsage(
      { cwd: 'E:/project/rate-identity' },
      { codexHome: home },
    )
    assert.equal(usage.rate_limit_id, 'codex_bengalfox')
    assert.equal(usage.rate_limit_name, 'GPT-5.3-Codex-Spark')
    assert.equal(usage.rate_limits.five_hour.used_percentage, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

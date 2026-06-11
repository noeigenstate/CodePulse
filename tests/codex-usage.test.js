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
      context_used_percent: 1.25,
      rate_limits: {
        five_hour: { used_percentage: 34, resets_at: 1781160358, window_minutes: 300 },
        seven_day: { used_percentage: 5, resets_at: 1781747174, window_minutes: 10080 },
      },
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

import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CODEX_USAGE_POLL_INTERVAL_MS,
  readLatestCodexTokenSnapshot,
  readRecentCodexTokenSnapshots,
} from '../apps/desktop/src/main/codex-usage-poller.js'

test('Codex usage poller defaults to a responsive quota sync interval', () => {
  assert.equal(CODEX_USAGE_POLL_INTERVAL_MS, 5_000)
})

test('Codex usage poller reads latest rollout rate limits', async () => {
  const home = join(tmpdir(), `codepulse-codex-poller-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-poller.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'poller-session', cwd: 'E:/project/poller', model: 'gpt-5-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            total_token_usage: {
              input_tokens: 10000,
              cached_input_tokens: 3000,
              output_tokens: 400,
              reasoning_output_tokens: 80,
              total_tokens: 10480,
            },
            last_token_usage: {
              input_tokens: 5000,
              cached_input_tokens: 120,
              output_tokens: 400,
              total_tokens: 5400,
            },
          },
          rate_limits: {
            primary: { used_percent: 61, window_minutes: 300, resets_at: 1781160358 },
            secondary: { used_percent: 12, window_minutes: 10080, resets_at: 1781747174 },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const event = await readLatestCodexTokenSnapshot(home)
    assert.equal(event?.source, 'codex')
    assert.equal(event?.eventType, 'token_snapshot')
    assert.equal(event?.workspacePath, 'E:/project/poller')
    assert.equal(event?.model, 'gpt-5-codex')
    assert.equal(event?.token?.rateLimits?.fiveHour?.usedPercent, 61)
    assert.equal(event?.token?.rateLimits?.sevenDay?.usedPercent, 12)
    assert.equal(event?.token?.contextWindow, 256000)
    assert.equal(event?.token?.contextUsedPercent, 1.953125)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage poller reads recent token snapshots for multiple workspaces', async () => {
  const home = join(tmpdir(), `codepulse-codex-poller-multi-${Date.now()}`)
  const firstSessions = join(home, 'sessions', '2026', '06', '11')
  const secondSessions = join(home, 'sessions', '2026', '06', '12')
  const first = join(firstSessions, 'rollout-2026-06-11T10-00-00-first.jsonl')
  const second = join(secondSessions, 'rollout-2026-06-12T10-00-00-second.jsonl')

  await mkdir(firstSessions, { recursive: true })
  await mkdir(secondSessions, { recursive: true })
  await writeFile(
    first,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'first-session', cwd: 'E:/project/first', model: 'gpt-5-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            total_token_usage: { input_tokens: 12000, output_tokens: 800, total_tokens: 12800 },
            last_token_usage: { input_tokens: 12000, output_tokens: 800, total_tokens: 12800 },
          },
          rate_limits: { primary: { used_percent: 44 }, secondary: { used_percent: 18 } },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  await writeFile(
    second,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'second-session', cwd: 'E:/project/second', model: 'gpt-5.5' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 258000,
            total_token_usage: { input_tokens: 54000, output_tokens: 900, total_tokens: 54900 },
            last_token_usage: { input_tokens: 54000, output_tokens: 900, total_tokens: 54900 },
          },
          rate_limits: { primary: { used_percent: 67 }, secondary: { used_percent: 23 } },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const events = await readRecentCodexTokenSnapshots(home)
    const byWorkspace = new Map(events.map((event) => [event.workspacePath, event]))

    assert.equal(events.length, 2)
    assert.equal(byWorkspace.get('E:/project/first')?.externalSessionId, 'first-session')
    assert.equal(byWorkspace.get('E:/project/first')?.token?.rateLimits?.fiveHour?.usedPercent, 44)
    assert.equal(byWorkspace.get('E:/project/second')?.externalSessionId, 'second-session')
    assert.equal(
      byWorkspace.get('E:/project/second')?.token?.contextUsedPercent,
      20.930232558139537,
    )
    assert.equal(byWorkspace.get('E:/project/second')?.token?.rateLimits?.sevenDay?.usedPercent, 23)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage poller does not double count cached input for context percent', async () => {
  const home = join(tmpdir(), `codepulse-codex-poller-context-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-context.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'context-session', cwd: 'E:/project/context', model: 'gpt-5-codex' },
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
    const event = await readLatestCodexTokenSnapshot(home)
    assert.equal(event?.token?.contextUsedPercent, 50)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage poller parses 1M context window strings as one million tokens', async () => {
  const home = join(tmpdir(), `codepulse-codex-poller-window-unit-${Date.now()}`)
  const sessions = join(home, 'sessions', '2026', '06', '11')
  const rollout = join(sessions, 'rollout-2026-06-11T10-00-00-window-unit.jsonl')

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'window-unit', cwd: 'E:/project/window-unit', model: 'gpt-5-codex' },
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
    const event = await readLatestCodexTokenSnapshot(home)
    assert.equal(event?.token?.contextWindow, 1_000_000)
    assert.equal(event?.token?.contextUsedPercent, 25)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex usage poller scans newer session folders before capped history', async () => {
  const home = join(tmpdir(), `codepulse-codex-poller-cap-${Date.now()}`)
  const oldSessions = join(home, 'sessions', '2025', '01', '01')
  const freshSessions = join(home, 'sessions', '2026', '06', '11')
  const fresh = join(freshSessions, 'rollout-2026-06-11T10-00-00-fresh.jsonl')

  await mkdir(oldSessions, { recursive: true })
  await mkdir(freshSessions, { recursive: true })

  const oldPayload = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'old', cwd: 'E:/project/old', model: 'gpt-old' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          model_context_window: 100000,
          total_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
          last_token_usage: { input_tokens: 1000, output_tokens: 100, total_tokens: 1100 },
        },
        rate_limits: { primary: { used_percent: 7 } },
      },
    }),
  ].join('\n')
  await Promise.all(
    Array.from({ length: 310 }, (_, i) =>
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
      JSON.stringify({
        type: 'session_meta',
        payload: { id: 'fresh', cwd: 'E:/project/fresh', model: 'gpt-5-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 100000,
            total_token_usage: { input_tokens: 4200, output_tokens: 300, total_tokens: 4500 },
            last_token_usage: { input_tokens: 2000, output_tokens: 100, total_tokens: 2100 },
          },
          rate_limits: { primary: { used_percent: 61 } },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const event = await readLatestCodexTokenSnapshot(home)
    assert.equal(event?.workspacePath, 'E:/project/fresh')
    assert.equal(event?.model, 'gpt-5-codex')
    assert.equal(event?.token?.total, 4500)
    assert.equal(event?.token?.rateLimits?.fiveHour?.usedPercent, 61)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

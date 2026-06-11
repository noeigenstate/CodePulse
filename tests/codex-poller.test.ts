import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLatestCodexTokenSnapshot } from '../apps/desktop/src/main/codex-usage-poller.js'

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
    assert.equal(event?.token?.contextUsedPercent, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

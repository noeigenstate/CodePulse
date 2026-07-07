import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromClaudeStatusLine, fromCodexHook } from '@codepulse/adapters'

test('Claude status line sums current_usage cache tokens into context input', () => {
  const event = fromClaudeStatusLine({
    session_id: 'claude-token',
    model: { display_name: 'Claude Sonnet' },
    context_window: {
      context_window_size: 200000,
      current_usage: {
        input_tokens: 8500,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 2000,
        output_tokens: 1200,
      },
    },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
      seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
    },
  })

  assert.equal(event?.eventType, 'token_snapshot')
  assert.equal(event?.token?.input, 15500)
  assert.equal(event?.token?.output, 1200)
  assert.equal(event?.token?.total, 16700)
  assert.equal(event?.token?.contextUsedPercent, 7.75)
  assert.equal(event?.token?.rateLimits?.fiveHour?.usedPercent, 23.5)
  assert.equal(event?.token?.rateLimits?.fiveHour?.resetsAt, 1738425600)
  assert.equal(event?.token?.rateLimits?.sevenDay?.usedPercent, 41.2)
})

test('Claude status line parses 1M context window strings as one million tokens', () => {
  const event = fromClaudeStatusLine({
    channel: 'statusline',
    context_window: {
      context_window_size: '1M',
      current_usage: { input_tokens: 500000 },
    },
  })

  assert.equal(event?.token?.contextWindow, 1_000_000)
  assert.equal(event?.token?.contextUsedPercent, 50)
})

test('Claude status line prefers official used_percentage when present', () => {
  const event = fromClaudeStatusLine({
    session_id: 'claude-token',
    context_window: {
      total_input_tokens: 24000,
      total_output_tokens: 1000,
      context_window_size: 200000,
      used_percentage: 12.5,
      current_usage: {
        input_tokens: 8500,
        cache_creation_input_tokens: 5000,
        cache_read_input_tokens: 2000,
        output_tokens: 1200,
      },
    },
  })

  assert.equal(event?.token?.input, 24000)
  assert.equal(event?.token?.output, 1000)
  assert.equal(event?.token?.total, 25000)
  assert.equal(event?.token?.contextUsedPercent, 12.5)
})

test('Claude status line does not use cumulative total input as context percent fallback', () => {
  const event = fromClaudeStatusLine({
    session_id: 'claude-token',
    context_window: {
      total_input_tokens: 800000,
      context_window_size: 1000000,
      current_usage: {
        input_tokens: 100000,
        cache_creation_input_tokens: 50000,
        cache_read_input_tokens: 50000,
      },
    },
  })

  assert.equal(event?.token?.input, 800000)
  assert.equal(event?.token?.contextUsedPercent, 20)
})

test('Codex hook does not double count cached input for context percent', () => {
  const event = fromCodexHook({
    hook_event_name: 'UserPromptSubmit',
    context_window_size: 200000,
    usage: {
      input_tokens: 120000,
      cached_input_tokens: 90000,
      output_tokens: 1000,
      total_tokens: 121000,
    },
    context_usage: {
      input_tokens: 100000,
      cached_input_tokens: 90000,
      output_tokens: 1000,
      total_tokens: 101000,
    },
  })

  assert.equal(event?.token?.contextUsedPercent, 50)
})

test('Codex hook parses 1M context window strings as one million tokens', () => {
  const event = fromCodexHook({
    hook_event_name: 'UserPromptSubmit',
    context_window_size: '1M',
    context_usage: {
      input_tokens: 250000,
    },
  })

  assert.equal(event?.token?.contextWindow, 1_000_000)
  assert.equal(event?.token?.contextUsedPercent, 25)
})

test('Codex hook carries quota bucket identity from rate limits', () => {
  const event = fromCodexHook({
    hook_event_name: 'UserPromptSubmit',
    rate_limits: {
      limit_id: 'codex_bengalfox',
      limit_name: 'GPT-5.3-Codex-Spark',
      primary: { used_percent: 2, resets_at: 2_000, window_minutes: 300 },
      secondary: { used_percent: 1, resets_at: 9_000, window_minutes: 10_080 },
    },
  })

  assert.equal(event?.token?.rateLimitId, 'codex_bengalfox')
  assert.equal(event?.token?.rateLimitName, 'GPT-5.3-Codex-Spark')
  assert.equal(event?.token?.rateLimits?.fiveHour?.usedPercent, 2)
})

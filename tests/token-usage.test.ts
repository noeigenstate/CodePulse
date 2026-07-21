import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fromClaudeHook,
  fromClaudeStatusLine,
  fromCodexHook,
  fromGrokHook,
  fromKimiHook,
} from '@codepulse/adapters'

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
  // No official used_percentage → derived math is estimated.
  assert.equal(event?.token?.accuracy, 'estimated')
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
  assert.equal(event?.token?.accuracy, 'estimated')
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
  assert.equal(event?.token?.accuracy, 'exact')
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
  assert.equal(event?.token?.accuracy, 'estimated')
})

test('Claude adapters map native effort fields without using reasoning output tokens as depth', () => {
  const hook = fromClaudeHook({
    hook_event_name: 'UserPromptSubmit',
    model: 'claude-opus-4-8',
    effortLevel: 'HIGH',
    usage: { reasoning_output_tokens: 12_345 },
  })
  const statusLine = fromClaudeStatusLine({
    model: { display_name: 'Claude Opus 4.8' },
    settings: { effortLevel: 'xhigh' },
    usage: { reasoning_output_tokens: 54_321 },
  })

  assert.equal(hook?.reasoningEffort, 'high')
  assert.equal(statusLine?.reasoningEffort, 'xhigh')
  assert.equal(statusLine?.token?.reasoningOutput, 54_321)
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

test('Codex hook keeps reasoning effort separate from reasoning output tokens', () => {
  const event = fromCodexHook({
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6-terra',
    reasoning_effort: 'ultra',
    model_observed_at: 1_784_513_490_123,
    usage: { reasoning_output_tokens: 12_345 },
  })

  assert.equal(event?.model, 'gpt-5.6-terra')
  assert.equal(event?.reasoningEffort, 'ultra')
  assert.equal(event?.modelObservedAt, 1_784_513_490_123)
  assert.equal(event?.token?.reasoningOutput, 12_345)
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
  assert.equal(event?.token?.rateLimits?.sevenDay?.usedPercent, 1)
})

test('Codex hook maps weekly-only primary window (no 5h) to sevenDay', () => {
  const event = fromCodexHook({
    hook_event_name: 'UserPromptSubmit',
    rate_limits: {
      limit_id: 'codex',
      limit_name: null,
      primary: { used_percent: 2, window_minutes: 10080, resets_at: 1_784_513_490 },
      secondary: null,
    },
  })

  assert.equal(event?.token?.rateLimits?.fiveHour, undefined)
  assert.equal(event?.token?.rateLimits?.sevenDay?.usedPercent, 2)
  assert.equal(event?.token?.rateLimits?.sevenDay?.windowMinutes, 10080)
  assert.equal(event?.token?.rateLimits?.sevenDay?.resetsAt, 1_784_513_490)
})

test('Grok hook maps signals-style context and weekly credit rate limits', () => {
  const event = fromGrokHook({
    hookEventName: 'Stop',
    sessionId: 'grok-session',
    model: 'grok-4.5',
    usage: { input_tokens: 44907, total_tokens: 44907 },
    context_usage: { input_tokens: 44907, total_tokens: 44907 },
    context_window_size: 500000,
    context_used_percent: 8,
    rate_limits: {
      seven_day: { used_percentage: 1, resets_at: 1_784_000_000, window_minutes: 10080 },
    },
    rate_limit_name: 'SuperGrok',
    rate_limit_id: 'supergrok',
    usage_source_path: 'C:/Users/me/.grok/sessions/x/signals.json',
  })

  assert.equal(event?.eventType, 'turn_stop')
  assert.equal(event?.model, 'grok-4.5')
  assert.equal(event?.tokenSourcePath, 'C:/Users/me/.grok/sessions/x/signals.json')
  assert.equal(event?.token?.input, 44907)
  assert.equal(event?.token?.contextWindow, 500000)
  assert.equal(event?.token?.contextUsedPercent, 8)
  assert.equal(event?.token?.rateLimits?.sevenDay?.usedPercent, 1)
  assert.equal(event?.token?.rateLimits?.sevenDay?.resetsAt, 1_784_000_000)
  assert.equal(event?.token?.rateLimitName, 'SuperGrok')
  assert.equal(event?.token?.accuracy, 'estimated')
})

test('Kimi hook maps native effort and injected local context usage', () => {
  const event = fromKimiHook({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'kimi-session',
    cwd: 'E:/work/kimi',
    model: 'kimi-code/k3',
    thinking_effort: 'max',
    prompt: 'implement the feature',
    usage: {
      input_tokens: 50_000,
      cached_input_tokens: 48_000,
      output_tokens: 400,
      total_tokens: 50_400,
    },
    context_window_size: 200_000,
    context_used_percent: 25,
  })

  assert.equal(event?.source, 'kimi')
  assert.equal(event?.eventType, 'prompt_submit')
  assert.equal(event?.model, 'kimi-code/k3')
  assert.equal(event?.reasoningEffort, 'max')
  assert.equal(event?.token?.input, 50_000)
  assert.equal(event?.token?.cachedInput, 48_000)
  assert.equal(event?.token?.contextUsedPercent, 25)
  assert.equal(event?.token?.accuracy, 'estimated')
})

test('Kimi and Grok adapters do not promote tool-use ids to conversation turn ids', () => {
  const kimi = fromKimiHook({
    hook_event_name: 'PreToolUse',
    session_id: 'kimi-session',
    tool_use_id: 'kimi-tool-call',
    tool_name: 'shell',
  })
  const grok = fromGrokHook({
    hookEventName: 'PreToolUse',
    sessionId: 'grok-session',
    toolUseId: 'grok-tool-call',
    toolName: 'shell',
  })

  assert.equal(kimi?.externalTurnId, undefined)
  assert.equal(grok?.externalTurnId, undefined)
})

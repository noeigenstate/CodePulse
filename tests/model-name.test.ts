import assert from 'node:assert/strict'
import test from 'node:test'
import { formatModelName } from '../apps/desktop/src/renderer/src/lib/modelName.js'

test('raw Claude model IDs render like the Claude Code status line', () => {
  assert.equal(formatModelName('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(formatModelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5')
  assert.equal(formatModelName('claude-opus-4-20250514'), 'Opus 4')
  assert.equal(formatModelName('claude-haiku-4-5'), 'Haiku 4.5')
  assert.equal(formatModelName('claude-opus-4-6[1m]'), 'Opus 4.6 (1M)')
  assert.equal(formatModelName('claude-3-5-sonnet-20241022'), 'Sonnet 3.5')
})

test('display names and non-Claude models are left unchanged', () => {
  assert.equal(formatModelName('Opus 5.5'), 'Opus 5.5')
  assert.equal(formatModelName('gpt-5.3-codex'), 'gpt-5.3-codex')
  assert.equal(formatModelName('grok-code'), 'grok-code')
  assert.equal(formatModelName('claude-unknown-9'), 'claude-unknown-9')
})

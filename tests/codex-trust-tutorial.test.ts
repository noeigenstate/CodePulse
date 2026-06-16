import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@codepulse/shared'
import {
  CODEX_TRUST_ACKNOWLEDGED_STORAGE_KEY,
  acknowledgeCodexTrust,
  buildAgentSetupReminder,
  dismissAgentSetupReminder,
  readCodexTrustAcknowledged,
  shouldShowAgentSetupReminder,
} from '../apps/desktop/src/renderer/src/lib/codexTrustTutorial.js'

test('agent setup reminder stays hidden after first Codex trust acknowledgement', () => {
  const codex: Agent = {
    id: 'codex',
    type: 'codex',
    name: 'Codex',
    installed: true,
    configured: true,
  }
  const reminder = buildAgentSetupReminder([codex])

  assert.equal(reminder.needsCodexTrust, true)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, undefined, false), true)
  const dismissedCheckId = dismissAgentSetupReminder(1)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, dismissedCheckId, false), false)
  assert.equal(shouldShowAgentSetupReminder(reminder, 2, dismissedCheckId, true), false)
  assert.equal(shouldShowAgentSetupReminder(reminder, 2, dismissedCheckId, false), true)
})

test('agent setup reminder reports missing CLI and hook configuration issues', () => {
  const reminder = buildAgentSetupReminder([
    {
      id: 'codex',
      type: 'codex',
      name: 'Codex',
      installed: false,
      configured: false,
    },
    {
      id: 'claude_code',
      type: 'claude_code',
      name: 'Claude Code',
      installed: true,
      configured: false,
    },
  ])

  assert.deepEqual(reminder.missingCli, ['codex'])
  assert.deepEqual(reminder.missingHook, ['claude_code'])
  assert.equal(reminder.needsCodexTrust, false)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, undefined, true), true)
})

test('agent setup reminder stays hidden when no setup or trust issue is known', () => {
  const reminder = buildAgentSetupReminder([
    {
      id: 'claude_code',
      type: 'claude_code',
      name: 'Claude Code',
      installed: true,
      configured: true,
    },
  ])

  assert.deepEqual(reminder.missingCli, [])
  assert.deepEqual(reminder.missingHook, [])
  assert.equal(reminder.needsCodexTrust, false)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, undefined), false)
})

test('Codex trust acknowledgement is persisted in local storage', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    },
  }

  assert.equal(readCodexTrustAcknowledged(storage), false)
  assert.equal(acknowledgeCodexTrust(storage), true)
  assert.equal(values.get(CODEX_TRUST_ACKNOWLEDGED_STORAGE_KEY), '1')
  assert.equal(readCodexTrustAcknowledged(storage), true)
})

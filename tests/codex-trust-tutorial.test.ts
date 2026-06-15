import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent } from '@codepulse/shared'
import {
  buildAgentSetupReminder,
  dismissAgentSetupReminder,
  shouldShowAgentSetupReminder,
} from '../apps/desktop/src/renderer/src/lib/codexTrustTutorial.js'

test('agent setup reminder reappears on every new agent check until the user handles it', () => {
  const codex: Agent = {
    id: 'codex',
    type: 'codex',
    name: 'Codex',
    installed: true,
    configured: true,
  }
  const reminder = buildAgentSetupReminder([codex])

  assert.equal(reminder.needsCodexTrust, true)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, undefined), true)
  const dismissedCheckId = dismissAgentSetupReminder(1)
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, dismissedCheckId), false)
  assert.equal(shouldShowAgentSetupReminder(reminder, 2, dismissedCheckId), true)
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
  assert.equal(shouldShowAgentSetupReminder(reminder, 1, undefined), true)
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

import test from 'node:test'
import assert from 'node:assert/strict'
import { WORK_STATE_CODES, WORK_STATE_LABELS, TurnState } from '@codepulse/shared'
import { fromClaudeHook, fromCodexHook } from '@codepulse/adapters'
import { StatusHub, normalizeEvent } from '@codepulse/core'
import { turnStateLabel as desktop } from '../apps/desktop/src/renderer/src/lib/i18n.js'
import { turnStateLabel as hud } from '../apps/hud/src/renderer/src/lib/i18n.js'

test('all eleven lifecycle states share exact desktop/HUD bilingual labels', () => {
  assert.equal(WORK_STATE_CODES.length, 11)
  for (const locale of ['zh', 'en'] as const)
    for (const state of WORK_STATE_CODES) {
      assert.ok(WORK_STATE_LABELS[locale][state])
      assert.equal(desktop(state, locale), hud(state, locale))
      assert.equal(hud(state, locale), WORK_STATE_LABELS[locale][state])
      if (locale === 'en') assert.doesNotMatch(hud(state, locale), /[\u3400-\u9fff]/u)
    }
  assert.equal(hud(TurnState.WAITING_PERMISSION, 'en'), 'Awaiting approval')
  assert.equal(hud(TurnState.WAITING_USER_INPUT, 'en'), 'Awaiting input')
})

test('question tools, explicit approvals, idle notifications and final failures stay distinct', () => {
  const base = { session_id: 'fixture', cwd: 'C:/fixture' }
  const question = fromClaudeHook({
    ...base,
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
  })!
  assert.equal(question.eventType, 'user_input_required')
  assert.equal(
    fromClaudeHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })!.eventType,
    'permission_request',
  )
  assert.equal(
    fromClaudeHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion' })!
      .eventType,
    'user_input_required',
  )
  assert.equal(
    fromClaudeHook({
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      message: 'needs your input',
    }),
    null,
  )
  assert.equal(
    fromClaudeHook({
      ...base,
      hook_event_name: 'Notification',
      notification_type: 'elicitation_dialog',
    })!.eventType,
    'user_input_required',
  )
  assert.equal(fromClaudeHook({ ...base, hook_event_name: 'StopFailure' })!.eventType, 'turn_error')
  assert.equal(
    fromClaudeHook({ ...base, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }),
    null,
    'individual tool errors are not final turn failures',
  )
  for (const hook_event_name of ['PreToolUse', 'PermissionRequest']) {
    assert.equal(
      fromCodexHook({ ...base, hook_event_name, tool_name: 'request_user_input' })!.eventType,
      'user_input_required',
    )
    assert.equal(
      fromCodexHook({ ...base, hook_event_name, tool_name: 'functions.request_user_input' })!
        .eventType,
      'user_input_required',
    )
  }
  assert.equal(
    fromCodexHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'exec_command' })!
      .eventType,
    'permission_request',
  )
  const hub = new StatusHub()
  hub.ingest(normalizeEvent(question))
  hub.ingest(
    normalizeEvent(
      fromClaudeHook({
        ...base,
        hook_event_name: 'Notification',
        notification_type: 'permission_prompt',
      })!,
    ),
  )
  assert.equal(
    hub.snapshot().agents[0]!.state,
    TurnState.WAITING_USER_INPUT,
    'generic prompt cannot downgrade an explicit question',
  )
  hub.ingest(
    normalizeEvent(
      fromClaudeHook({ ...base, hook_event_name: 'PermissionRequest', tool_name: 'Bash' })!,
    ),
  )
  assert.equal(hub.snapshot().agents[0]!.state, TurnState.WAITING_PERMISSION)
  assert.equal(hub.snapshot().agents[0]!.needUserInput, false)
  hub.ingest(
    normalizeEvent(fromClaudeHook({ ...base, hook_event_name: 'PostToolUse', tool_name: 'Bash' })!),
  )
  assert.equal(hub.snapshot().agents[0]!.state, TurnState.THINKING)
})

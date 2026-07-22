import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TurnState } from '@codepulse/shared'
import {
  hudStateLevel,
  hudStatePriority,
  needsHudAttention,
} from '../apps/desktop/src/renderer/src/lib/hudState.js'

test('HUD reserves attention styling for unread results and intervention states', () => {
  assert.equal(hudStateLevel({ state: TurnState.IDLE, unread: false }), 'quiet')
  assert.equal(hudStateLevel({ state: TurnState.THINKING, unread: false }), 'active')
  assert.equal(hudStateLevel({ state: TurnState.DONE, unread: false }), 'quiet')
  assert.equal(hudStateLevel({ state: TurnState.DONE, unread: true }), 'notice')
  assert.equal(hudStateLevel({ state: TurnState.WAITING_PERMISSION, unread: false }), 'action')
  assert.equal(hudStateLevel({ state: TurnState.ERROR, unread: true }), 'fault')
  assert.equal(hudStateLevel({ state: TurnState.ERROR, unread: false }), 'quiet')
  assert.equal(hudStateLevel({ state: TurnState.CANCELLED, unread: true }), 'quiet')
})

test('HUD attention predicate follows the semantic level rather than agent brand', () => {
  assert.equal(needsHudAttention({ state: TurnState.TOOL_RUNNING, unread: false }), false)
  assert.equal(needsHudAttention({ state: TurnState.WAITING_USER_INPUT, unread: false }), true)
  assert.equal(needsHudAttention({ state: TurnState.USAGE_LIMITED, unread: true }), true)
})

test('HUD representative priority keeps alerts ahead of overlapping active work', () => {
  assert.ok(
    hudStatePriority({ state: TurnState.DONE, unread: true }) >
      hudStatePriority({ state: TurnState.TOOL_RUNNING, unread: false }),
  )
  assert.ok(
    hudStatePriority({ state: TurnState.WAITING_PERMISSION, unread: false }) >
      hudStatePriority({ state: TurnState.DONE, unread: true }),
  )
  assert.ok(
    hudStatePriority({ state: TurnState.ERROR, unread: true }) >
      hudStatePriority({ state: TurnState.WAITING_PERMISSION, unread: false }),
  )
})

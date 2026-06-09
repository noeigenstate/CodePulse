/**
 * The final, generic normalization step every event passes through before
 * entering the state machine. Source-specific shaping lives in
 * `@codepulse/adapters`; this module only fills in the universally-required
 * `id`/`timestamp` fields and provides a cheap shape guard.
 *
 * @module core/event-normalizer
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventInput } from '@codepulse/shared'

/**
 * Completes a partially-specified event into a full {@link AgentEvent}.
 *
 * A hook script may omit `id` and `timestamp`; this assigns a random UUID and
 * the current time when they are missing, leaving all other fields untouched.
 *
 * @param input The adapter-produced event, possibly missing `id`/`timestamp`.
 * @returns A complete {@link AgentEvent} ready for the state machine.
 */
export function normalizeEvent(input: AgentEventInput): AgentEvent {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
  }
}

/**
 * Lightweight runtime guard for the minimum fields required on an event input.
 *
 * Used by the HTTP layer to reject obviously malformed payloads without paying
 * for full schema validation.
 *
 * @param value An arbitrary, untrusted value (e.g. a parsed request body).
 * @returns `true` if `value` has string `source` and `eventType` fields.
 */
export function isPlausibleEventInput(value: unknown): value is AgentEventInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.source === 'string' && typeof v.eventType === 'string'
}

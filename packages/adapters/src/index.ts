/**
 * `@codepulse/adapters` — translates the agent-specific hook / status-line
 * payloads that arrive at `POST /api/events` into the normalized
 * {@link AgentEventInput} the rest of the system consumes.
 *
 * @module adapters
 */
import type { AgentEventInput } from '@codepulse/shared'
import { asRecord, pickString } from './util.js'
import { fromCodexHook } from './codex/index.js'
import { fromClaudeHook, fromClaudeStatusLine } from './claude-code/index.js'

export * from './codex/index.js'
export * from './claude-code/index.js'

/**
 * Dispatches a raw payload to the correct adapter based on its `source` and
 * `channel`. Hook scripts post `{ source, channel?, ...native }`; the Claude
 * status-line collector uses `channel: 'statusline'`.
 *
 * @param raw The parsed request body (untrusted).
 * @returns The normalized event input, or `null` if no adapter recognises it.
 */
export function normalizeRawEvent(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null
  const source = pickString(r, 'source', 'agent')
  const channel = pickString(r, 'channel')

  if (source === 'claude_code') {
    return channel === 'statusline' ? fromClaudeStatusLine(raw) : fromClaudeHook(raw)
  }
  if (source === 'codex') {
    return fromCodexHook(raw)
  }
  return null
}

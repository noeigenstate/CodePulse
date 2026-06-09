/**
 * Codex adapter. Maps Codex's lifecycle hook payloads onto the normalized
 * {@link AgentEventInput} shape (requirements §6.1).
 *
 * @module adapters/codex
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickNumber, pickString, preview } from '../util.js'

/**
 * Maps a Codex hook payload into an {@link AgentEventInput}.
 *
 * Token data is treated as best-effort (`accuracy: 'estimated'`) since Codex
 * token accounting is not a V0.1 guarantee. Field names are read defensively to
 * tolerate differences between Codex builds.
 *
 * @param raw The parsed hook payload (untrusted).
 * @returns The normalized event input, or `null` if unrecognised.
 */
export function fromCodexHook(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null

  const hookEvent = pickString(r, 'hook_event_name', 'hookEvent', 'event', 'type')
  if (!hookEvent) return null

  const eventType = mapCodexEvent(hookEvent)
  if (!eventType) return null

  const event: AgentEventInput = {
    source: 'codex',
    eventType,
    externalSessionId: pickString(r, 'session_id', 'sessionId', 'conversation_id'),
    externalTurnId: pickString(r, 'turn_id', 'turnId'),
    cwd: pickString(r, 'cwd'),
    workspacePath: pickString(r, 'workspace', 'cwd', 'project_dir'),
    model: pickString(r, 'model'),
    raw,
  }

  switch (eventType) {
    case 'tool_start':
    case 'tool_end':
      event.toolName = pickString(r, 'tool_name', 'toolName', 'tool')
      event.command = pickString(r, 'command', 'cmd')
      break
    case 'permission_request':
      event.toolName = pickString(r, 'tool_name', 'toolName', 'tool')
      event.command = pickString(r, 'command', 'cmd')
      event.message = pickString(r, 'message') ?? '请求执行操作'
      break
    case 'prompt_submit':
      event.message = preview(pickString(r, 'prompt', 'user_prompt'))
      break
    case 'turn_stop':
      event.message = preview(pickString(r, 'last_message', 'assistant_message', 'message'))
      break
  }

  const token = extractCodexToken(r)
  if (token) event.token = token

  return event
}

/**
 * Maps a native Codex hook event name onto the normalized event vocabulary.
 *
 * @param hookEvent The hook event name from the payload.
 * @returns The mapped event type, or `null` for unrecognised events.
 */
function mapCodexEvent(hookEvent: string): AgentEventType | null {
  switch (hookEvent) {
    case 'SessionStart':
      return 'session_start'
    case 'UserPromptSubmit':
      return 'prompt_submit'
    case 'PreToolUse':
      return 'tool_start'
    case 'PostToolUse':
      return 'tool_end'
    case 'PermissionRequest':
      return 'permission_request'
    case 'Stop':
      return 'turn_stop'
    case 'Error':
      return 'turn_error'
    case 'SessionEnd':
      return 'session_end'
    default:
      return null
  }
}

/**
 * Extracts best-effort token usage from a Codex payload.
 *
 * @param raw The hook payload.
 * @returns An estimated token payload, or `undefined` if no usage is present.
 */
function extractCodexToken(raw: Record<string, unknown>): AgentEventInput['token'] | undefined {
  const usage = asRecord(raw.usage ?? raw.token) ?? raw
  const input = pickNumber(usage, 'input_tokens', 'inputTokens')
  const output = pickNumber(usage, 'output_tokens', 'outputTokens')
  const total = pickNumber(usage, 'total_tokens', 'totalTokens')
  const pct = pickNumber(raw, 'context_used_percent', 'contextUsedPercent')
  if (input == null && output == null && total == null && pct == null) return undefined
  return {
    input,
    output,
    total,
    contextUsedPercent: pct,
    accuracy: 'estimated',
  }
}

/**
 * Claude Code adapter. Maps Claude's hook JSON and status-line JSON onto the
 * normalized {@link AgentEventInput} shape (requirements §6.2).
 *
 * @module adapters/claude-code
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickNumber, pickString, preview } from '../util.js'

/**
 * Maps a Claude Code hook payload into an {@link AgentEventInput}.
 *
 * Claude hook JSON carries `hook_event_name`, `session_id`, `cwd`, `tool_name`,
 * etc. The `Notification` hook is overloaded for both permission prompts and
 * idle "waiting for input" states, so it is disambiguated on the message text.
 *
 * @param raw The parsed hook payload (untrusted).
 * @returns The normalized event input, or `null` if the payload is unrecognised
 *   or is an event CodePulse ignores (e.g. `SubagentStop`).
 */
export function fromClaudeHook(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null

  const hookEvent = pickString(r, 'hook_event_name', 'hookEvent', 'event')
  if (!hookEvent) return null

  const base = {
    source: 'claude_code' as const,
    externalSessionId: pickString(r, 'session_id', 'sessionId'),
    cwd: pickString(r, 'cwd'),
    workspacePath: pickString(r, 'workspace', 'project_dir', 'cwd'),
    model: pickString(r, 'model'),
    raw,
  }

  const eventType = mapClaudeEvent(hookEvent, r)
  if (!eventType) return null

  const event: AgentEventInput = { ...base, eventType }

  switch (eventType) {
    case 'tool_start':
    case 'tool_end':
      event.toolName = pickString(r, 'tool_name', 'toolName')
      event.command = extractCommand(r)
      break
    case 'permission_request':
      event.toolName = pickString(r, 'tool_name', 'toolName')
      event.message = pickString(r, 'message') ?? '请求授权'
      break
    case 'user_input_required':
      event.message = pickString(r, 'message') ?? '等待用户继续输入'
      break
    case 'prompt_submit':
      event.message = preview(pickString(r, 'prompt', 'user_prompt'))
      break
    case 'turn_stop':
      event.message = preview(pickString(r, 'last_message', 'assistant_message'))
      break
  }

  return event
}

/**
 * Maps a native Claude hook event name onto the normalized event vocabulary.
 *
 * @param hookEvent The `hook_event_name` from the payload.
 * @param raw The full payload, used to classify the overloaded `Notification`.
 * @returns The mapped event type, or `null` for events CodePulse ignores.
 */
function mapClaudeEvent(
  hookEvent: string,
  raw: Record<string, unknown>,
): AgentEventType | null {
  switch (hookEvent) {
    case 'SessionStart':
      return 'session_start'
    case 'UserPromptSubmit':
      return 'prompt_submit'
    case 'PreToolUse':
      return 'tool_start'
    case 'PostToolUse':
      return 'tool_end'
    case 'Notification':
      return classifyNotification(pickString(raw, 'message'))
    case 'Stop':
      return 'turn_stop'
    case 'SubagentStop':
      return null // ignored for now — does not end the user-visible turn
    case 'SessionEnd':
      return 'session_end'
    default:
      return null
  }
}

/**
 * Classifies an overloaded `Notification` hook as a permission request or an
 * input request, based on keywords in its message.
 *
 * @param message The notification message text, if any.
 * @returns `'permission_request'` for permission-like text, else
 *   `'user_input_required'`.
 */
function classifyNotification(message: string | undefined): AgentEventType {
  const text = (message ?? '').toLowerCase()
  if (text.includes('permission') || text.includes('approve') || text.includes('授权')) {
    return 'permission_request'
  }
  return 'user_input_required'
}

/**
 * Extracts a representative command/path from a tool-use payload's `tool_input`.
 *
 * @param raw The hook payload.
 * @returns A command/path string for display, or `undefined`.
 */
function extractCommand(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(raw.tool_input ?? raw.toolInput)
  if (!input) return undefined
  return pickString(input, 'command', 'cmd', 'file_path', 'path')
}

/**
 * Maps a Claude Code status-line payload into a `token_snapshot` event.
 *
 * The status-line collector forwards the structured JSON Claude provides
 * (model, workspace, cost, token usage, context %). Because this comes from a
 * stable structured source, the snapshot is tagged `accuracy: 'exact'`.
 *
 * @param raw The parsed status-line payload (untrusted).
 * @returns The normalized token-snapshot event, or `null` if not an object.
 */
export function fromClaudeStatusLine(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null

  const cost = asRecord(r.cost)
  const model = asRecord(r.model)
  const workspace = asRecord(r.workspace)
  const usage = asRecord(r.usage) ?? r

  return {
    source: 'claude_code',
    eventType: 'token_snapshot',
    externalSessionId: pickString(r, 'session_id', 'sessionId'),
    cwd: pickString(r, 'cwd') ?? (workspace ? pickString(workspace, 'current_dir', 'cwd') : undefined),
    workspacePath: workspace
      ? pickString(workspace, 'project_dir', 'current_dir')
      : pickString(r, 'cwd'),
    model: model ? pickString(model, 'display_name', 'id') : pickString(r, 'model'),
    token: {
      input: pickNumber(usage, 'input_tokens', 'inputTokens'),
      output: pickNumber(usage, 'output_tokens', 'outputTokens'),
      total: pickNumber(usage, 'total_tokens', 'totalTokens'),
      contextUsedPercent:
        pickNumber(r, 'context_used_percent', 'contextUsedPercent') ??
        (usage ? pickNumber(usage, 'context_used_percent') : undefined),
      costUsd: cost ? pickNumber(cost, 'total_cost_usd', 'total_cost') : pickNumber(r, 'cost_usd'),
      accuracy: 'exact',
    },
    raw,
  }
}

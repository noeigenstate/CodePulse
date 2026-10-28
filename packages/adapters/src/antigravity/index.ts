import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickString } from '../util.js'

/** Official Antigravity hook input uses camelCase; no transcript/credential scraping. */
export function fromAntigravityHook(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null
  const session = pickString(r, 'conversationId')
  if (!session) return null // Never coalesce independent conversations into a provider slot.
  const hook = pickString(r, 'hook_event_name')
  const tool = asRecord(r.toolCall)
  let eventType: AgentEventType
  switch (hook) {
    case 'SessionStart': eventType = 'session_start'; break
    case 'PreInvocation':
      eventType = 'model_start'; break
    case 'PreToolUse': eventType = tool?.name === 'ask_question' ? 'user_input_required' : 'tool_start'; break
    case 'PostToolUse': eventType = 'tool_end'; break
    case 'Stop':
      if (r.fullyIdle !== true) return null // Background commands are still running.
      eventType = r.terminationReason === 'error' || Boolean(r.error) ? 'turn_error'
        : r.terminationReason === 'max_steps_exceeded' ? 'turn_timeout' : 'turn_stop'
      break
    // PostInvocation ends one model call, not the user-visible task.
    default: return null
  }
  const workspace = Array.isArray(r.workspacePaths) ? r.workspacePaths.find((v): v is string => typeof v === 'string' && !!v.trim()) : undefined
  return {
    source: 'antigravity', eventType, externalSessionId: session,
    workspacePath: workspace, cwd: workspace, model: pickString(r, 'modelName'),
    toolName: tool ? pickString(tool, 'name') : undefined,
    message: hook === 'Stop' && eventType !== 'turn_stop' ? 'Antigravity execution stopped with an error or limit' : undefined,
    raw,
  }
}

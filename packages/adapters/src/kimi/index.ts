/**
 * Normalizes Kimi Code lifecycle hook payloads for CodePulse.
 *
 * @module adapters/kimi
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import {
  asRecord,
  pickNumber,
  pickRateLimitId,
  pickRateLimitName,
  pickRateLimits,
  pickString,
  preview,
} from '../util.js'

/**
 * Maps an untrusted Kimi Code hook payload to a normalized event.
 *
 * @param raw Parsed hook payload.
 * @returns A normalized event, or `null` for unsupported event types.
 */
export function fromKimiHook(raw: unknown): AgentEventInput | null {
  const record = asRecord(raw)
  if (!record) return null

  const nativeEvent = pickString(
    record,
    'hook_event_name',
    'hookEventName',
    'hookEvent',
    'event',
    'type',
  )
  if (!nativeEvent) return null
  const eventType = mapKimiEvent(nativeEvent, record)
  if (!eventType) return null

  const event: AgentEventInput = {
    source: 'kimi',
    eventType,
    externalSessionId: pickString(record, 'session_id', 'sessionId'),
    externalTurnId: pickString(record, 'turn_id', 'turnId', 'tool_use_id', 'toolUseId'),
    cwd: pickString(record, 'cwd'),
    workspacePath: pickString(record, 'workspace', 'project_dir', 'workspace_root', 'cwd'),
    model: pickString(record, 'model', 'modelAlias', 'model_alias'),
    reasoningEffort: normalizeEffort(
      pickString(record, 'thinking_effort', 'thinkingEffort', 'reasoning_effort', 'effort'),
    ),
    tokenSourcePath: pickString(record, 'usage_source_path', 'usageSourcePath'),
    raw,
  }

  switch (eventType) {
    case 'tool_start':
    case 'tool_end':
      event.toolName = pickString(record, 'tool_name', 'toolName', 'tool')
      event.command = extractCommand(record)
      break
    case 'permission_request':
      event.toolName = pickString(record, 'tool_name', 'toolName', 'tool')
      event.command = extractCommand(record)
      event.message = pickString(record, 'message', 'reason') ?? '请求执行操作'
      break
    case 'user_input_required':
      event.message = pickString(record, 'message') ?? '等待用户继续输入'
      break
    case 'usage_limited':
      event.message = pickString(record, 'message') ?? '已达用量上限，任务暂时停止'
      break
    case 'prompt_submit':
      event.message = preview(pickString(record, 'prompt', 'user_prompt', 'message'))
      break
    case 'turn_stop':
    case 'turn_cancelled':
    case 'turn_error':
      event.message = preview(
        pickString(record, 'last_message', 'assistant_message', 'message', 'reason'),
      )
      break
  }

  const token = extractKimiToken(record)
  if (token) event.token = token
  return event
}

/** Maps Kimi's tolerant event spelling to the shared event vocabulary. */
function mapKimiEvent(nativeEvent: string, raw: Record<string, unknown>): AgentEventType | null {
  switch (normalizeEventName(nativeEvent)) {
    case 'sessionstart':
      return 'session_start'
    case 'userpromptsubmit':
      return 'prompt_submit'
    case 'pretooluse':
      return 'tool_start'
    case 'posttooluse':
    case 'posttoolusefailure':
      return 'tool_end'
    case 'permissionrequest':
      return 'permission_request'
    case 'notification':
      return classifyNotification(pickString(raw, 'message', 'notification_type'))
    case 'stop':
      return 'turn_stop'
    case 'stopfailure':
      return 'turn_error'
    case 'interrupt':
    case 'cancel':
    case 'cancelled':
    case 'canceled':
      return 'turn_cancelled'
    case 'sessionend':
      return 'session_end'
    case 'permissionresult':
    case 'subagentstart':
    case 'subagentstop':
    case 'precompact':
    case 'postcompact':
      return null
    default:
      return null
  }
}

/** Extracts the token patch injected by the local Kimi usage reader. */
function extractKimiToken(raw: Record<string, unknown>): AgentEventInput['token'] | undefined {
  const usage = asRecord(raw.usage ?? raw.token)
  const contextUsage = asRecord(raw.context_usage ?? raw.contextUsage)
  const input = pickNumber(usage ?? {}, 'input_tokens', 'inputTokens')
  const cachedInput = pickNumber(usage ?? {}, 'cached_input_tokens', 'cachedInputTokens')
  const output = pickNumber(usage ?? {}, 'output_tokens', 'outputTokens')
  const total = pickNumber(usage ?? {}, 'total_tokens', 'totalTokens')
  const contextWindow = pickNumber(raw, 'context_window_size', 'contextWindowSize')
  const contextInput = pickNumber(contextUsage ?? usage ?? {}, 'input_tokens', 'inputTokens')
  const contextUsedPercent =
    pickNumber(raw, 'context_used_percent', 'contextUsedPercent') ??
    percentOf(contextInput, contextWindow)
  const rateLimits = pickRateLimits(raw)

  if (
    input == null &&
    cachedInput == null &&
    output == null &&
    total == null &&
    contextUsedPercent == null &&
    !rateLimits
  ) {
    return undefined
  }
  return {
    input,
    cachedInput,
    output,
    total,
    contextWindow,
    contextUsedPercent,
    rateLimits,
    rateLimitId: pickRateLimitId(raw),
    rateLimitName: pickRateLimitName(raw),
    accuracy: 'estimated',
  }
}

function normalizeEventName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\s-]/g, '')
}

function normalizeEffort(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  return normalized && /^[a-z][a-z0-9_-]{0,31}$/.test(normalized) ? normalized : undefined
}

function classifyNotification(message: string | undefined): AgentEventType | null {
  const text = (message ?? '').toLowerCase()
  if (!text) return null
  if (
    text.includes('usage limit') ||
    text.includes('rate limit') ||
    text.includes('usage quota') ||
    text.includes('billing cycle')
  ) {
    return 'usage_limited'
  }
  if (text.includes('permission') || text.includes('approve') || text.includes('allow')) {
    return 'permission_request'
  }
  if (text.includes('input required') || text.includes('needs your input')) {
    return 'user_input_required'
  }
  return null
}

function extractCommand(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(raw.tool_input ?? raw.toolInput)
  return input ? pickString(input, 'command', 'cmd', 'file_path', 'path') : undefined
}

function percentOf(value: number | undefined, total: number | undefined): number | undefined {
  if (value == null || total == null || total <= 0) return undefined
  return Math.min(100, Math.max(0, (value / total) * 100))
}

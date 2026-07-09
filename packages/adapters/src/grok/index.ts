/**
 * Grok Build CLI 适配器。把 Grok 生命周期 hook 载荷映射到归一化的
 * {@link AgentEventInput} 形态。
 *
 * Grok hook stdin 多为 camelCase（`hookEventName`、`sessionId`、`workspaceRoot`），
 * 事件名可能是 `SessionStart` 或 `session_start`；同时兼容 Claude 风格字段。
 *
 * @module adapters/grok
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickString, preview } from '../util.js'

/**
 * 把 Grok Build 的 hook 载荷映射为 {@link AgentEventInput}。
 *
 * @param raw 解析后的 hook 载荷（不可信）。
 * @returns 归一化事件输入；无法识别时为 `null`。
 */
export function fromGrokHook(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null

  const hookEvent = pickString(r, 'hook_event_name', 'hookEventName', 'hookEvent', 'event', 'type')
  if (!hookEvent) return null

  const eventType = mapGrokEvent(hookEvent, r)
  if (!eventType) return null

  const event: AgentEventInput = {
    source: 'grok',
    eventType,
    externalSessionId: pickString(r, 'session_id', 'sessionId'),
    externalTurnId: pickString(r, 'turn_id', 'turnId', 'toolUseId', 'tool_use_id'),
    cwd: pickString(r, 'cwd'),
    workspacePath: pickString(
      r,
      'workspaceRoot',
      'workspace_root',
      'workspace',
      'project_dir',
      'cwd',
    ),
    model: pickString(r, 'model'),
    raw,
  }

  switch (eventType) {
    case 'tool_start':
    case 'tool_end':
      event.toolName = pickString(r, 'tool_name', 'toolName', 'tool')
      event.command = extractCommand(r)
      break
    case 'permission_request':
      event.toolName = pickString(r, 'tool_name', 'toolName', 'tool')
      event.command = extractCommand(r)
      event.message = pickString(r, 'message', 'reason') ?? '请求执行操作'
      break
    case 'user_input_required':
      event.message = pickString(r, 'message') ?? '等待用户继续输入'
      break
    case 'usage_limited':
      event.message = pickString(r, 'message') ?? '已达用量上限，任务暂时停止'
      break
    case 'prompt_submit':
      event.message = preview(
        pickString(r, 'prompt', 'user_prompt', 'userPrompt', 'message') ??
          extractPromptFromInput(r),
      )
      break
    case 'turn_stop':
    case 'turn_cancelled':
    case 'turn_error':
      event.message = preview(
        pickString(r, 'last_message', 'assistant_message', 'message', 'reason'),
      )
      break
  }

  return event
}

/**
 * 把 Grok 原生 hook 事件名映射到归一化事件词汇表。
 *
 * @param hookEvent 载荷中的 hook 事件名（PascalCase / snake_case / camelCase）。
 * @param raw 完整载荷，用于区分 `Notification` 语义。
 */
function mapGrokEvent(hookEvent: string, raw: Record<string, unknown>): AgentEventType | null {
  const normalized = normalizeHookEventName(hookEvent)

  switch (normalized) {
    case 'sessionstart':
      return 'session_start'
    case 'userpromptsubmit':
      return 'prompt_submit'
    case 'pretooluse':
      return 'tool_start'
    case 'posttooluse':
      return 'tool_end'
    case 'posttoolusefailure':
      return 'tool_end'
    case 'permissiondenied':
      return 'permission_request'
    case 'notification':
      return classifyNotification(pickString(raw, 'message', 'notificationType', 'type'))
    case 'stop':
      return 'turn_stop'
    case 'stopfailure':
      return 'turn_error'
    case 'cancel':
    case 'cancelled':
    case 'canceled':
    case 'abort':
    case 'aborted':
    case 'interrupted':
      return 'turn_cancelled'
    case 'sessionend':
      return 'session_end'
    case 'subagentstart':
    case 'subagentstop':
    case 'subagentend':
    case 'precompact':
    case 'postcompact':
      return null
    default:
      return null
  }
}

/** 去掉分隔符并小写，统一 `SessionStart` / `session_start` / `sessionStart`。 */
function normalizeHookEventName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]/g, '')
}

function classifyNotification(message: string | undefined): AgentEventType | null {
  const text = (message ?? '').toLowerCase()
  if (!text) return null
  if (
    text.includes('session limit') ||
    text.includes('usage limit') ||
    text.includes('rate limit') ||
    (text.includes('hit your') && text.includes('limit'))
  ) {
    return 'usage_limited'
  }
  if (
    text.includes('permission') ||
    text.includes('approve') ||
    text.includes('allow') ||
    text.includes('deny') ||
    text.includes('授权')
  ) {
    return 'permission_request'
  }
  if (
    text.includes('input required') ||
    text.includes('needs your input') ||
    text.includes('需要输入') ||
    text.includes('等待输入')
  ) {
    return 'user_input_required'
  }
  return null
}

function extractCommand(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(raw.tool_input ?? raw.toolInput)
  if (!input) return undefined
  return pickString(input, 'command', 'cmd', 'file_path', 'path', 'target_file')
}

function extractPromptFromInput(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(raw.tool_input ?? raw.toolInput ?? raw.promptInput)
  if (!input) return undefined
  return pickString(input, 'prompt', 'message', 'text')
}

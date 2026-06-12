/**
 * Codex 适配器。把 Codex 的生命周期 hook 载荷映射到归一化的
 * {@link AgentEventInput} 形态（需求 §6.1）。
 *
 * @module adapters/codex
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickNumber, pickRateLimits, pickString, preview } from '../util.js'

const DEFAULT_CODEX_CONTEXT_WINDOW = 256_000

/**
 * 把 Codex 的 hook 载荷映射为 {@link AgentEventInput}。
 *
 * token 数据按尽力而为处理（`accuracy: 'estimated'`），因为 Codex 的
 * token 统计不是 V0.1 的保证项。字段名采用防御式读取，
 * 以容忍不同 Codex 构建之间的差异。
 *
 * @param raw 解析后的 hook 载荷（不可信）。
 * @returns 归一化事件输入；无法识别时为 `null`。
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
    tokenSourcePath: pickString(
      r,
      'token_source_path',
      'tokenSourcePath',
      'usage_source_path',
      'usageSourcePath',
      'rollout_path',
      'transcript_path',
    ),
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
    case 'turn_cancelled':
      event.message = preview(pickString(r, 'last_message', 'assistant_message', 'message'))
      break
  }

  const token = extractCodexToken(r)
  if (token) event.token = token

  return event
}

/**
 * 把 Codex 原生 hook 事件名映射到归一化事件词汇表。
 *
 * @param hookEvent 载荷中的 hook 事件名。
 * @returns 映射后的事件类型；无法识别时为 `null`。
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
    case 'Cancel':
    case 'Cancelled':
    case 'Canceled':
    case 'Abort':
    case 'Aborted':
    case 'Interrupted':
      return 'turn_cancelled'
    case 'Error':
      return 'turn_error'
    case 'SessionEnd':
      return 'session_end'
    default:
      return null
  }
}

/**
 * 从 Codex 载荷中尽力提取 token 用量。
 *
 * @param raw hook 载荷。
 * @returns 估算的 token 载荷；无任何用量数据时为 `undefined`。
 */
function extractCodexToken(raw: Record<string, unknown>): AgentEventInput['token'] | undefined {
  const info = asRecord(raw.info)
  const usage = asRecord(raw.usage ?? raw.token ?? info?.total_token_usage) ?? raw
  const contextUsage = asRecord(raw.context_usage ?? raw.contextUsage ?? info?.last_token_usage)
  const input = pickNumber(usage, 'input_tokens', 'inputTokens')
  const cachedInput = pickNumber(usage, 'cached_input_tokens', 'cachedInputTokens')
  const output = pickNumber(usage, 'output_tokens', 'outputTokens')
  const reasoningOutput = pickNumber(usage, 'reasoning_output_tokens', 'reasoningOutputTokens')
  const total = pickNumber(usage, 'total_tokens', 'totalTokens')
  const contextWindow =
    pickNumber(raw, 'context_window_size', 'contextWindowSize') ??
    pickNumber(info ?? {}, 'model_context_window', 'modelContextWindow') ??
    DEFAULT_CODEX_CONTEXT_WINDOW
  const contextSource = contextUsage ?? usage
  const contextInput =
    pickNumber(contextSource, 'input_tokens', 'inputTokens') ??
    pickNumber(contextSource, 'cached_input_tokens', 'cachedInputTokens')
  const pct =
    pickNumber(raw, 'context_used_percent', 'contextUsedPercent') ??
    pickNumber(usage, 'context_used_percent', 'contextUsedPercent') ??
    percentOf(contextInput, contextWindow)
  const costUsd = pickNumber(raw, 'cost_usd', 'costUsd') ?? pickNumber(usage, 'cost_usd', 'costUsd')
  const rateLimits = pickRateLimits(raw)
  if (
    input == null &&
    cachedInput == null &&
    output == null &&
    reasoningOutput == null &&
    total == null &&
    pct == null &&
    costUsd == null &&
    !rateLimits
  ) {
    return undefined
  }
  return {
    input,
    cachedInput,
    output,
    reasoningOutput,
    total,
    contextUsedPercent: pct,
    contextWindow,
    rateLimits,
    costUsd,
    accuracy: 'estimated',
  }
}

function percentOf(value: number | undefined, total: number | undefined): number | undefined {
  if (value == null || total == null || total <= 0) return undefined
  return Math.min(100, (value / total) * 100)
}

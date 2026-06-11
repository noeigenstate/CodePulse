/**
 * Claude Code 适配器。把 Claude 的 hook JSON 与 status-line JSON
 * 映射到归一化的 {@link AgentEventInput} 形态（需求 §6.2）。
 *
 * @module adapters/claude-code
 */
import type { AgentEventInput, AgentEventType } from '@codepulse/shared'
import { asRecord, pickNumber, pickRateLimits, pickString, preview } from '../util.js'

/**
 * 把 Claude Code 的 hook 载荷映射为 {@link AgentEventInput}。
 *
 * Claude 的 hook JSON 携带 `hook_event_name`、`session_id`、`cwd`、
 * `tool_name` 等字段。`Notification` hook 同时承担授权提示与
 * 空闲「等待输入」两种含义，因此根据消息文本进行区分。
 *
 * @param raw 解析后的 hook 载荷（不可信）。
 * @returns 归一化事件输入；若载荷无法识别或属于 CodePulse 忽略的
 *   事件（如 `SubagentStop`）则为 `null`。
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
    case 'turn_cancelled':
      event.message = preview(pickString(r, 'last_message', 'assistant_message'))
      break
  }

  return event
}

/**
 * 把 Claude 原生 hook 事件名映射到归一化事件词汇表。
 *
 * @param hookEvent 载荷中的 `hook_event_name`。
 * @param raw 完整载荷，用于区分语义重载的 `Notification`。
 * @returns 映射后的事件类型；CodePulse 忽略的事件返回 `null`。
 */
function mapClaudeEvent(hookEvent: string, raw: Record<string, unknown>): AgentEventType | null {
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
    case 'Cancel':
    case 'Cancelled':
    case 'Canceled':
    case 'Abort':
    case 'Aborted':
    case 'Interrupted':
      return 'turn_cancelled'
    case 'SubagentStop':
      return null // 暂时忽略 —— 不会结束用户可见的轮次
    case 'SessionEnd':
      return 'session_end'
    default:
      return null
  }
}

/**
 * 根据消息关键字，把语义重载的 `Notification` hook 分类为
 * 授权请求或输入请求。
 *
 * @param message 通知消息文本（如有）。
 * @returns 含授权类文本时为 `'permission_request'`，否则为
 *   `'user_input_required'`。
 */
function classifyNotification(message: string | undefined): AgentEventType {
  const text = (message ?? '').toLowerCase()
  if (text.includes('permission') || text.includes('approve') || text.includes('授权')) {
    return 'permission_request'
  }
  return 'user_input_required'
}

/**
 * 从工具调用载荷的 `tool_input` 中提取有代表性的命令/路径。
 *
 * @param raw hook 载荷。
 * @returns 用于展示的命令/路径字符串，或 `undefined`。
 */
function extractCommand(raw: Record<string, unknown>): string | undefined {
  const input = asRecord(raw.tool_input ?? raw.toolInput)
  if (!input) return undefined
  return pickString(input, 'command', 'cmd', 'file_path', 'path')
}

/**
 * 把 Claude Code 的 status-line 载荷映射为 `token_snapshot` 事件。
 *
 * status-line 收集器转发 Claude 提供的结构化 JSON（模型、工作区、
 * 花费、token 用量、上下文百分比）。由于来源是稳定的结构化数据，
 * 快照被标记为 `accuracy: 'exact'`。
 *
 * @param raw 解析后的 status-line 载荷（不可信）。
 * @returns 归一化的 token 快照事件；非对象时为 `null`。
 */
export function fromClaudeStatusLine(raw: unknown): AgentEventInput | null {
  const r = asRecord(raw)
  if (!r) return null

  const cost = asRecord(r.cost)
  const model = asRecord(r.model)
  const workspace = asRecord(r.workspace)
  const contextWindow = asRecord(r.context_window ?? r.contextWindow)
  const usage = asRecord(r.usage) ?? r
  const contextUsage = asRecord(contextWindow?.current_usage ?? contextWindow?.currentUsage)
  const usageSource = contextUsage ?? usage
  const currentInput = sumKnown(
    pickNumber(contextUsage ?? {}, 'input_tokens', 'inputTokens'),
    pickNumber(contextUsage ?? {}, 'cache_read_input_tokens', 'cacheReadInputTokens'),
    pickNumber(contextUsage ?? {}, 'cache_creation_input_tokens', 'cacheCreationInputTokens'),
  )
  const input =
    pickNumber(contextWindow ?? {}, 'total_input_tokens', 'totalInputTokens') ??
    currentInput ??
    pickNumber(usageSource, 'input_tokens', 'inputTokens')
  const output =
    pickNumber(contextWindow ?? {}, 'total_output_tokens', 'totalOutputTokens') ??
    pickNumber(usageSource, 'output_tokens', 'outputTokens')
  const total = pickNumber(usageSource, 'total_tokens', 'totalTokens') ?? sumKnown(input, output)
  const contextWindowSize = pickNumber(
    contextWindow ?? {},
    'context_window_size',
    'contextWindowSize',
  )
  const contextUsedPercent =
    pickNumber(contextWindow ?? {}, 'used_percentage', 'usedPercentage') ??
    pickNumber(r, 'context_used_percent', 'contextUsedPercent') ??
    pickNumber(usageSource, 'context_used_percent', 'contextUsedPercent') ??
    percentOf(input, contextWindowSize)

  return {
    source: 'claude_code',
    eventType: 'token_snapshot',
    externalSessionId: pickString(r, 'session_id', 'sessionId'),
    cwd:
      pickString(r, 'cwd') ?? (workspace ? pickString(workspace, 'current_dir', 'cwd') : undefined),
    workspacePath: workspace
      ? pickString(workspace, 'project_dir', 'current_dir')
      : pickString(r, 'cwd'),
    model: model ? pickString(model, 'display_name', 'id') : pickString(r, 'model'),
    token: {
      input,
      output,
      total,
      contextUsedPercent,
      contextWindow: contextWindowSize,
      cachedInput: sumKnown(
        pickNumber(contextUsage ?? {}, 'cache_read_input_tokens', 'cacheReadInputTokens'),
        pickNumber(contextUsage ?? {}, 'cache_creation_input_tokens', 'cacheCreationInputTokens'),
      ),
      reasoningOutput: pickNumber(usageSource, 'reasoning_output_tokens', 'reasoningOutputTokens'),
      rateLimits: pickRateLimits(r),
      costUsd: cost ? pickNumber(cost, 'total_cost_usd', 'total_cost') : pickNumber(r, 'cost_usd'),
      accuracy: 'exact',
    },
    raw,
  }
}

function sumKnown(...values: Array<number | undefined>): number | undefined {
  if (values.every((value) => value == null)) return undefined
  let sum = 0
  for (const value of values) sum += value ?? 0
  return sum
}

function percentOf(value: number | undefined, total: number | undefined): number | undefined {
  if (value == null || total == null || total <= 0) return undefined
  return Math.min(100, (value / total) * 100)
}

/**
 * `@codepulse/adapters` —— 把到达 `POST /api/events` 的 agent 专有
 * hook / status-line 载荷翻译为系统其余部分消费的归一化
 * {@link AgentEventInput}。
 *
 * @module adapters
 */
import type { AgentEventInput } from '@codepulse/shared'
import { asRecord, pickString } from './util.js'
import { fromCodexHook } from './codex/index.js'
import { fromClaudeHook, fromClaudeStatusLine } from './claude-code/index.js'
import { fromGrokHook } from './grok/index.js'

export * from './codex/index.js'
export * from './claude-code/index.js'
export * from './grok/index.js'

/**
 * 根据载荷的 `source` 与 `channel` 派发到正确的适配器。
 * hook 脚本提交 `{ source, channel?, ...native }`；
 * Claude status-line 收集器使用 `channel: 'statusline'`。
 *
 * @param raw 解析后的请求体（不可信）。
 * @returns 归一化事件输入；无适配器识别时为 `null`。
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
  if (source === 'grok') {
    return fromGrokHook(raw)
  }
  return null
}

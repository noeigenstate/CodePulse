/**
 * 每个事件进入状态机前经过的最终通用归一化步骤。来源相关的整形逻辑
 * 在 `@codepulse/adapters` 中；本模块只补全所有事件都必需的
 * `id`/`timestamp` 字段，并提供一个轻量的形态守卫。
 *
 * @module core/event-normalizer
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentEventInput } from '@codepulse/shared'

/**
 * 把部分指定的事件补全为完整的 {@link AgentEvent}。
 *
 * hook 脚本可以省略 `id` 与 `timestamp`；缺失时本函数分配随机 UUID
 * 和当前时间，其余字段保持不变。
 *
 * @param input 适配器产生的事件，可能缺少 `id`/`timestamp`。
 * @returns 可直接进入状态机的完整 {@link AgentEvent}。
 */
export function normalizeEvent(input: AgentEventInput): AgentEvent {
  return {
    ...input,
    id: input.id ?? randomUUID(),
    timestamp: input.timestamp ?? Date.now(),
  }
}

/**
 * 对事件输入最低必需字段的轻量运行时守卫。
 *
 * HTTP 层用它拒绝明显畸形的载荷，而无需付出完整 schema 校验的成本。
 *
 * @param value 任意不可信值（如解析后的请求体）。
 * @returns 若 `value` 具有字符串类型的 `source` 与 `eventType` 字段则为 `true`。
 */
export function isPlausibleEventInput(value: unknown): value is AgentEventInput {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.source === 'string' && typeof v.eventType === 'string'
}

/**
 * 事件接收路由：`POST /api/events`。这是 hook 脚本上报 agent 活动
 * 的入口。
 *
 * @module local-server/routes/events
 */
import type { FastifyInstance } from 'fastify'
import { normalizeEvent, type StatusHub } from '@codepulse/core'
import { normalizeRawEvent } from '@codepulse/adapters'
import { writeClaudeQuotaCache } from '../claude-quota.js'

const MAX_EVENT_BATCH = 1000

/**
 * 注册 `POST /api/events`。
 *
 * 接受单个原始 hook 载荷或其数组。每一项先经适配器
 * （`normalizeRawEvent`）再经归一化器（`normalizeEvent`）处理后
 * 投喂给 hub。无法识别的项被计数并忽略，而不是让整个请求失败。
 * 至少接受一个事件时返回 `202`，否则返回 `400`。
 *
 * @param app 注册路由的 Fastify 实例。
 * @param hub 接收已接受事件的状态 hub。
 */
export function registerEventRoutes(app: FastifyInstance, hub: StatusHub): void {
  app.post('/api/events', async (request, reply) => {
    const body = request.body
    const items = Array.isArray(body) ? body : [body]
    if (items.length > MAX_EVENT_BATCH) {
      reply.code(413)
      return { error: 'too_many_events', max: MAX_EVENT_BATCH }
    }

    let accepted = 0
    const ignored: unknown[] = []

    for (const item of items) {
      const input = normalizeRawEvent(item)
      if (!input) {
        ignored.push(item)
        continue
      }
      const event = normalizeEvent(input)
      hub.ingest(event)
      // Persist Claude account quota so session-sync can re-apply it without statusline.
      if (event.source === 'claude_code' && event.token?.rateLimits) {
        void writeClaudeQuotaCache({
          rateLimits: event.token.rateLimits,
          rateLimitId: event.token.rateLimitId,
          rateLimitName: event.token.rateLimitName,
          source: 'statusline',
        })
      }
      accepted += 1
    }

    reply.code(accepted > 0 ? 202 : 400)
    return { accepted, ignored: ignored.length }
  })
}

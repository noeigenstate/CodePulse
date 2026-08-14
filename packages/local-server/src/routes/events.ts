/**
 * 事件接收路由：`POST /api/events`。这是 hook 脚本上报 agent 活动
 * 的入口。
 *
 * @module local-server/routes/events

 */
import type { FastifyInstance } from 'fastify'
import { normalizeEvent, type StatusHub } from '@codepulse/core'
import { normalizeRawEvent } from '@codepulse/adapters'
import type { TokenPayload } from '@codepulse/shared'
import { writeClaudeQuotaCache } from '../claude-quota.js'
import { resolveEventWorkspacePaths, WorkspacePathResolver } from '../workspace-path.js'

const MAX_EVENT_BATCH = 1000

/** Optional hooks for coordinating event ingestion with background services. */
export interface EventRouteOptions {
  /** Returns whether Codex account quota comes from the App Server API. */
  isCodexQuotaAuthoritative?: () => boolean
  /** Schedules an account-quota refresh for a relevant Codex lifecycle event. */
  onCodexEvent?: (event: ReturnType<typeof normalizeEvent>) => void
}

/**
 * 注册 `POST /api/events`。
 *
 * 接受单个原始 hook 载荷或其数组。每一项先经适配器
 * （`normalizeRawEvent`）再经归一化器（`normalizeEvent`）处理后
 * 投喂给 hub。无法识别的项被计数并忽略，而不是让整个请求失败。
 * 至少接受一个事件时返回 `202`，否则返回 `400`。每个路由实例还持有
 * 一个有界路径解析器，在 StatusHub 推导项目键之前归一化符号链接和
 * junction 别名。
 *
 * @param app 注册路由的 Fastify 实例。
 * @param hub 接收已归一化事件的状态 hub。
 * @param options Background synchronization callbacks for Codex events.

 */
export function registerEventRoutes(
  app: FastifyInstance,
  hub: StatusHub,
  options: EventRouteOptions = {},
): void {
  const workspacePaths = new WorkspacePathResolver()

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
      const rawInput = normalizeRawEvent(item)
      if (!rawInput) {
        ignored.push(item)
        continue
      }
      const input = await resolveEventWorkspacePaths(
        withHookDeliveryMetadata(rawInput, item),
        workspacePaths,
      )
      let event = normalizeEvent(input)
      if (event.source === 'codex' && options.isCodexQuotaAuthoritative?.()) {
        event = { ...event, token: withoutAccountQuota(event.token) }
      }
      const applied = hub.ingest(event)
      // Persist Claude account quota so session-sync can re-apply it without statusline.
      if (applied && event.source === 'claude_code' && event.token?.rateLimits) {
        void writeClaudeQuotaCache({
          rateLimits: event.token.rateLimits,
          rateLimitId: event.token.rateLimitId,
          rateLimitName: event.token.rateLimitName,
          source: 'statusline',
        })
      }
      if (applied && event.source === 'codex') {
        options.onCodexEvent?.(event)
      }
      accepted += 1
    }

    reply.code(accepted > 0 ? 202 : 400)
    return { accepted, ignored: ignored.length }
  })
}

/**
 * Restores retry-stable delivery metadata added by the local hook sender.
 *
 * Source adapters intentionally ignore transport-only fields. The route adds
 * them back after source normalization so a response lost after ingestion does
 * not turn the sender's retry into a second tool event or notification.
 *
 * @param input Adapter-normalized event input.
 * @param raw Raw HTTP batch item supplied by the hook sender.
 * @returns Event input carrying a validated stable ID and timestamp when present.

 */
function withHookDeliveryMetadata(
  input: Parameters<typeof normalizeEvent>[0],
  raw: unknown,
): Parameters<typeof normalizeEvent>[0] {
  if (typeof raw !== 'object' || raw === null) return input
  const record = raw as Record<string, unknown>
  const id = record._codepulse_event_id
  const timestamp = record._codepulse_timestamp
  return {
    ...input,
    ...(typeof id === 'string' && id.trim() ? { id: id.trim() } : {}),
    ...(typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > 0
      ? { timestamp }
      : {}),
  }
}

/**
 * Removes account-wide quota fields while retaining session-local token data.
 *
 * @param token Token payload reported by a Codex hook.
 * @returns A quota-free token payload, or the original missing value.

 */
function withoutAccountQuota(token: TokenPayload | undefined): TokenPayload | undefined {
  if (!token) return undefined
  const { rateLimits, quotaBuckets, rateLimitId, rateLimitName, ...sessionToken } = token
  void rateLimits
  void quotaBuckets
  void rateLimitId
  void rateLimitName
  return sessionToken
}

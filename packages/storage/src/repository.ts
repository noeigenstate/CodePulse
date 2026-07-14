/**
 * 持久化仓储。把归一化事件翻译为对 `events`、`sessions`、`turns`、
 * `token_snapshots` 各表的插入/更新，并提供应用所需的读取/维护查询。
 *
 * @module storage/repository
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt } from 'drizzle-orm'
import { TurnState, isActiveState, type AgentEvent } from '@codepulse/shared'
import type { DB } from './sqlite/db.js'
import { events, sessions, tokenSnapshots, turns, workspaces } from './sqlite/schema.js'

/**
 * 持久化一个归一化事件，并推进派生的会话/轮次/token 行。
 *
 * 在单个事务内运行，使只追加事件日志与派生聚合永不分叉。
 * 具体地：总是插入事件；确保会话行存在；在 `prompt_submit` 时开启轮次；
 * 在 `turn_stop`/`turn_error` 时关闭最近的轮次；事件携带 token 数据时
 * 记录一条 token 快照。
 *
 * @param db Drizzle 数据库句柄。
 * @param event 待持久化的归一化事件。
 */
export function persistEvent(db: DB, event: AgentEvent): void {
  db.transaction((tx) => {
    tx.insert(events)
      .values({
        id: event.id,
        source: event.source,
        eventType: event.eventType,
        externalSessionId: event.externalSessionId,
        externalTurnId: event.externalTurnId,
        workspacePath: event.workspacePath ?? event.cwd,
        model: event.model,
        toolName: event.toolName,
        command: event.command,
        message: event.message,
        raw: event.raw === undefined ? null : JSON.stringify(event.raw),
        timestamp: event.timestamp,
      })
      .run()

    const sessionId = ensureSession(tx, event)

    if (event.eventType === 'prompt_submit') {
      tx.insert(turns)
        .values({
          id: randomUUID(),
          sessionId,
          externalTurnId: event.externalTurnId,
          state: 'PROMPT_SUBMITTED',
          promptPreview: event.message,
          startedAt: event.timestamp,
          toolCallCount: 0,
          needPermission: false,
          needUserInput: false,
        })
        .run()
    }

    if (
      event.eventType === 'turn_stop' ||
      event.eventType === 'turn_error' ||
      event.eventType === 'turn_cancelled' ||
      event.eventType === 'turn_timeout' ||
      event.eventType === 'usage_limited'
    ) {
      closeLatestTurn(tx, sessionId, event)
    }

    if (event.token) {
      const turnId = findLatestTurnId(tx, sessionId, event.externalTurnId)
      tx.insert(tokenSnapshots)
        .values({
          id: randomUUID(),
          sessionId,
          turnId,
          agentType: event.source,
          inputTokens: event.token.input,
          outputTokens: event.token.output,
          totalTokens: event.token.total,
          contextUsedPercent: event.token.contextUsedPercent,
          costUsd: event.token.costUsd,
          accuracy: event.token.accuracy,
          capturedAt: event.timestamp,
        })
        .run()
    }
  })
}

/**
 * 查找事件对应的会话，不存在时创建一个。
 *
 * 还会刷新模型字段，并在 `session_end` 时关闭会话。
 *
 * @param tx 活动事务句柄。
 * @param event 正在持久化的事件。
 * @returns 内部会话 id。
 */
function ensureSession(tx: DB, event: AgentEvent): string {
  const externalId = event.externalSessionId ?? `${event.source}:unknown`
  const workspaceId = ensureWorkspace(tx, event.workspacePath ?? event.cwd, event.timestamp)
  const existing = tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.agentType, event.source), eq(sessions.externalSessionId, externalId)))
    .limit(1)
    .all()

  if (existing.length > 0) {
    const patch: { model?: string; workspaceId?: string; state?: string; endedAt?: number } = {}
    if (event.model) patch.model = event.model
    if (workspaceId) patch.workspaceId = workspaceId
    if (event.eventType === 'session_end') {
      patch.state = 'done'
      patch.endedAt = event.timestamp
    }
    if (Object.keys(patch).length > 0) {
      tx.update(sessions).set(patch).where(eq(sessions.id, existing[0]!.id)).run()
    }
    return existing[0]!.id
  }

  const id = randomUUID()
  tx.insert(sessions)
    .values({
      id,
      agentType: event.source,
      externalSessionId: externalId,
      workspaceId,
      model: event.model,
      state: 'running',
      startedAt: event.timestamp,
    })
    .run()
  return id
}

/** 确保工作区行存在，并刷新 lastActiveAt。 */
function ensureWorkspace(
  tx: DB,
  path: string | undefined,
  timestamp: number,
): string | undefined {
  if (!path) return undefined
  const normalized = path.trim().replace(/[\\/]+$/, '')
  if (!normalized) return undefined

  const existing = tx
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.path, normalized))
    .limit(1)
    .all()

  if (existing.length > 0) {
    tx.update(workspaces)
      .set({ lastActiveAt: timestamp })
      .where(eq(workspaces.id, existing[0]!.id))
      .run()
    return existing[0]!.id
  }

  const id = randomUUID()
  const name =
    normalized
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() || normalized
  tx.insert(workspaces)
    .values({
      id,
      name,
      path: normalized,
      lastActiveAt: timestamp,
    })
    .run()
  return id
}

/**
 * 关闭会话中最近开始的轮次，标记为 DONE 或 ERROR。
 *
 * @param tx 活动事务句柄。
 * @param sessionId 需要关闭最近轮次的会话。
 * @param event 终结事件（`turn_stop` 或 `turn_error`）。
 */
function closeLatestTurn(tx: DB, sessionId: string, event: AgentEvent): void {
  const latest = tx
    .select({ id: turns.id, state: turns.state })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(desc(turns.startedAt))
    .limit(20)
    .all()
  const openTurn = latest.find((turn) => isOpenTurnState(turn.state))
  if (!openTurn) return
  tx.update(turns)
    .set({
      state: closeTurnState(event),
      endedAt: event.timestamp,
      lastAssistantMessage: event.message,
    })
    .where(eq(turns.id, openTurn.id))
    .run()
}

function closeTurnState(event: AgentEvent): string {
  if (event.eventType === 'turn_error') return TurnState.ERROR
  if (event.eventType === 'turn_cancelled') return TurnState.CANCELLED
  if (event.eventType === 'turn_timeout') return TurnState.TIMEOUT
  if (event.eventType === 'usage_limited') return TurnState.USAGE_LIMITED
  return TurnState.DONE
}

function findLatestTurnId(
  tx: DB,
  sessionId: string,
  externalTurnId: string | undefined,
): string | undefined {
  const latest = tx
    .select({ id: turns.id, externalTurnId: turns.externalTurnId, state: turns.state })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(desc(turns.startedAt))
    .limit(20)
    .all()
  if (externalTurnId) {
    const matching = latest.find((turn) => turn.externalTurnId === externalTurnId)
    if (matching) return matching.id
  }
  return latest.find((turn) => isOpenTurnState(turn.state))?.id ?? latest[0]?.id
}

function isOpenTurnState(state: string): boolean {
  return isActiveState(state as TurnState)
}

/**
 * 返回最近的会话，按时间倒序。
 *
 * @param db Drizzle 数据库句柄。
 * @param limit 最大行数（默认 50）。
 * @returns 按开始时间降序排列的会话行。
 */
export function recentSessions(db: DB, limit = 50) {
  return db.select().from(sessions).orderBy(desc(sessions.startedAt)).limit(limit).all()
}

/**
 * 返回最近的原始事件，按时间倒序。
 *
 * @param db Drizzle 数据库句柄。
 * @param limit 最大行数（默认 100）。
 * @returns 按时间戳降序排列的事件行。
 */
export function recentEvents(db: DB, limit = 100) {
  return db.select().from(events).orderBy(desc(events.timestamp)).limit(limit).all()
}

/**
 * 删除早于截止时间的事件与 token 快照 —— 数据保留策略
 * （需求 §9，「数据保留天数」）。
 *
 * @param db Drizzle 数据库句柄。
 * @param cutoff epoch 毫秒；严格早于该时间的行被删除。
 */
export function pruneEventsBefore(db: DB, cutoff: number): void {
  db.delete(events).where(lt(events.timestamp, cutoff)).run()
  db.delete(tokenSnapshots).where(lt(tokenSnapshots.capturedAt, cutoff)).run()
}

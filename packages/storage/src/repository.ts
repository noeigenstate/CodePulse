/**
 * Persistence repository. Translates normalized events into inserts/updates
 * across the `events`, `sessions`, `turns`, and `token_snapshots` tables, and
 * provides the read/maintenance queries the app needs.
 *
 * @module storage/repository
 */
import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt } from 'drizzle-orm'
import type { AgentEvent } from '@codepulse/shared'
import type { DB } from './sqlite/db.js'
import { events, sessions, tokenSnapshots, turns } from './sqlite/schema.js'

/**
 * Persists a normalized event and advances the derived session/turn/token rows.
 *
 * Runs in a single transaction so the append-only event log and the derived
 * aggregates can never diverge. Specifically it: always inserts the event;
 * ensures a session row exists; opens a turn on `prompt_submit`; closes the
 * latest turn on `turn_stop`/`turn_error`; and records a token snapshot when the
 * event carries token data.
 *
 * @param db The Drizzle database handle.
 * @param event The normalized event to persist.
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

    if (event.eventType === 'turn_stop' || event.eventType === 'turn_error') {
      closeLatestTurn(tx, sessionId, event)
    }

    if (event.token) {
      tx.insert(tokenSnapshots)
        .values({
          id: randomUUID(),
          sessionId,
          turnId: event.externalTurnId,
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
 * Finds the session for an event, creating one if it does not exist yet.
 *
 * Also refreshes the model and closes the session on `session_end`.
 *
 * @param tx The active transaction handle.
 * @param event The event being persisted.
 * @returns The internal session id.
 */
function ensureSession(tx: DB, event: AgentEvent): string {
  const externalId = event.externalSessionId ?? `${event.source}:unknown`
  const existing = tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(eq(sessions.agentType, event.source), eq(sessions.externalSessionId, externalId)),
    )
    .limit(1)
    .all()

  if (existing.length > 0) {
    if (event.model) {
      tx.update(sessions).set({ model: event.model }).where(eq(sessions.id, existing[0]!.id)).run()
    }
    if (event.eventType === 'session_end') {
      tx.update(sessions)
        .set({ state: 'done', endedAt: event.timestamp })
        .where(eq(sessions.id, existing[0]!.id))
        .run()
    }
    return existing[0]!.id
  }

  const id = randomUUID()
  tx.insert(sessions)
    .values({
      id,
      agentType: event.source,
      externalSessionId: externalId,
      model: event.model,
      state: 'running',
      startedAt: event.timestamp,
    })
    .run()
  return id
}

/**
 * Closes the most recently started turn in a session, marking it DONE or ERROR.
 *
 * @param tx The active transaction handle.
 * @param sessionId The session whose latest turn should be closed.
 * @param event The terminating event (`turn_stop` or `turn_error`).
 */
function closeLatestTurn(tx: DB, sessionId: string, event: AgentEvent): void {
  const latest = tx
    .select({ id: turns.id })
    .from(turns)
    .where(eq(turns.sessionId, sessionId))
    .orderBy(desc(turns.startedAt))
    .limit(1)
    .all()
  if (latest.length === 0) return
  tx.update(turns)
    .set({
      state: event.eventType === 'turn_error' ? 'ERROR' : 'DONE',
      endedAt: event.timestamp,
      lastAssistantMessage: event.message,
    })
    .where(eq(turns.id, latest[0]!.id))
    .run()
}

/**
 * Returns the most recent sessions, newest first.
 *
 * @param db The Drizzle database handle.
 * @param limit Maximum number of rows (default 50).
 * @returns Session rows ordered by start time descending.
 */
export function recentSessions(db: DB, limit = 50) {
  return db.select().from(sessions).orderBy(desc(sessions.startedAt)).limit(limit).all()
}

/**
 * Returns the most recent raw events, newest first.
 *
 * @param db The Drizzle database handle.
 * @param limit Maximum number of rows (default 100).
 * @returns Event rows ordered by timestamp descending.
 */
export function recentEvents(db: DB, limit = 100) {
  return db.select().from(events).orderBy(desc(events.timestamp)).limit(limit).all()
}

/**
 * Deletes events and token snapshots older than a cutoff — the data-retention
 * policy (requirements §9, "数据保留天数").
 *
 * @param db The Drizzle database handle.
 * @param cutoff Epoch millis; rows strictly older than this are removed.
 */
export function pruneEventsBefore(db: DB, cutoff: number): void {
  db.delete(events).where(lt(events.timestamp, cutoff)).run()
  db.delete(tokenSnapshots).where(lt(tokenSnapshots.capturedAt, cutoff)).run()
}

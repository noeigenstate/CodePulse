/**
 * Drizzle ORM schema — the single source of truth for the SQLite tables and the
 * input for `drizzle-kit generate`. Mirrors the data model in requirements §7
 * (agents, workspaces, sessions, turns, token snapshots) plus a raw `events`
 * audit log.
 *
 * @module storage/sqlite/schema
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Monitored agents and their install/configuration status (requirements §7.1). */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  installed: integer('installed', { mode: 'boolean' }).notNull().default(false),
  configured: integer('configured', { mode: 'boolean' }).notNull().default(false),
  version: text('version'),
  lastSeenAt: integer('last_seen_at'),
})

/** Project directories agents work in (requirements §7.2). */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  gitBranch: text('git_branch'),
  lastActiveAt: integer('last_active_at').notNull(),
})

/** Agent conversations, keyed externally by `(agent_type, external_session_id)`. */
export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    agentType: text('agent_type').notNull(),
    externalSessionId: text('external_session_id').notNull(),
    workspaceId: text('workspace_id'),
    model: text('model'),
    state: text('state').notNull().default('idle'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => ({
    externalIdx: index('sessions_external_idx').on(t.agentType, t.externalSessionId),
  }),
)

/** One prompt → response cycle within a session (requirements §7.4). */
export const turns = sqliteTable(
  'turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    externalTurnId: text('external_turn_id'),
    state: text('state').notNull(),
    promptPreview: text('prompt_preview'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    toolCallCount: integer('tool_call_count').notNull().default(0),
    needPermission: integer('need_permission', { mode: 'boolean' }).notNull().default(false),
    needUserInput: integer('need_user_input', { mode: 'boolean' }).notNull().default(false),
    lastAssistantMessage: text('last_assistant_message'),
  },
  (t) => ({
    sessionIdx: index('turns_session_idx').on(t.sessionId),
  }),
)

/** Point-in-time token/context usage measurements (requirements §7.5). */
export const tokenSnapshots = sqliteTable(
  'token_snapshots',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    agentType: text('agent_type').notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    totalTokens: integer('total_tokens'),
    contextUsedPercent: real('context_used_percent'),
    costUsd: real('cost_usd'),
    accuracy: text('accuracy').notNull().default('unknown'),
    capturedAt: integer('captured_at').notNull(),
  },
  (t) => ({
    sessionIdx: index('token_session_idx').on(t.sessionId),
  }),
)

/** Append-only log of every normalized event, for replay and debugging. */
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    eventType: text('event_type').notNull(),
    externalSessionId: text('external_session_id'),
    externalTurnId: text('external_turn_id'),
    workspacePath: text('workspace_path'),
    model: text('model'),
    toolName: text('tool_name'),
    command: text('command'),
    message: text('message'),
    raw: text('raw'),
    timestamp: integer('timestamp').notNull(),
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    sessionIdx: index('events_session_idx').on(t.externalSessionId),
    tsIdx: index('events_ts_idx').on(t.timestamp),
  }),
)

/** Row type inferred from the {@link agents} table. */
export type AgentRow = typeof agents.$inferSelect
/** Row type inferred from the {@link sessions} table. */
export type SessionRow = typeof sessions.$inferSelect
/** Row type inferred from the {@link turns} table. */
export type TurnRow = typeof turns.$inferSelect
/** Row type inferred from the {@link events} table. */
export type EventRow = typeof events.$inferSelect
/** Row type inferred from the {@link tokenSnapshots} table. */
export type TokenSnapshotRow = typeof tokenSnapshots.$inferSelect

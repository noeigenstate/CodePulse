/**
 * Drizzle ORM schema —— SQLite 表结构的唯一可信来源，也是
 * `drizzle-kit generate` 的输入。对应需求 §7 的数据模型
 * （agents、workspaces、sessions、turns、token 快照），
 * 外加一个原始 `events` 审计日志。
 *
 * @module storage/sqlite/schema
 */
import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** 被监控的 agent 及其安装/配置状态（需求 §7.1）。 */
export const agents = sqliteTable('agents', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  name: text('name').notNull(),
  installed: integer('installed', { mode: 'boolean' }).notNull().default(false),
  configured: integer('configured', { mode: 'boolean' }).notNull().default(false),
  version: text('version'),
  lastSeenAt: integer('last_seen_at'),
})

/** agent 工作所在的项目目录（需求 §7.2）。 */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  path: text('path').notNull().unique(),
  gitBranch: text('git_branch'),
  lastActiveAt: integer('last_active_at').notNull(),
})

/** agent 对话，对外以 `(agent_type, external_session_id)` 为键。 */
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

/** 会话内一次「提示 → 回复」循环（需求 §7.4）。 */
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

/** token/上下文用量的时间点测量（需求 §7.5）。 */
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

/** 所有归一化事件的只追加日志，用于回放与调试。 */
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
    /** Legacy privacy-disabled column. New writes and migrations always keep it null. */
    command: text('command'),
    message: text('message'),
    /** Allowlisted extensions derived from commands; never contains paths or arguments. */
    fileTypeHints: text('file_type_hints'),
    /** Legacy privacy-disabled column. A database trigger rejects non-null writes. */
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

/** 由 {@link agents} 表推断出的行类型。 */
export type AgentRow = typeof agents.$inferSelect
/** 由 {@link sessions} 表推断出的行类型。 */
export type SessionRow = typeof sessions.$inferSelect
/** 由 {@link turns} 表推断出的行类型。 */
export type TurnRow = typeof turns.$inferSelect
/** 由 {@link events} 表推断出的行类型。 */
export type EventRow = typeof events.$inferSelect
/** 由 {@link tokenSnapshots} 表推断出的行类型。 */
export type TokenSnapshotRow = typeof tokenSnapshots.$inferSelect

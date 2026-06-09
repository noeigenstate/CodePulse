/**
 * Live runtime view types: the in-memory state the Dashboard renders, the
 * aggregated tray indicator, the minimal hardware projection, and the
 * server→client push/notification payloads.
 *
 * @module shared/types/runtime
 */
import type { AgentType } from './agent.js'
import type { TurnState } from './state.js'
import type { TokenPayload } from './token.js'

/**
 * Live, in-memory view of a single agent's current activity.
 *
 * This is what the Dashboard renders and what `/api/status` returns per agent.
 * Unlike the persisted {@link Session}/{@link Turn} rows, it is rebuilt from
 * events on every transition and never written to disk directly.
 */
export interface AgentRuntimeState {
  /** Which agent this state describes. */
  agentType: AgentType
  /** Current fine-grained state. */
  state: TurnState
  /** Agent-assigned session id, when known. */
  externalSessionId?: string
  /** Agent-assigned turn id, when known. */
  externalTurnId?: string
  /** Workspace path the agent is working in. */
  workspacePath?: string
  /** Model in use, when known. */
  model?: string
  /** Short human description of the current activity, e.g. `"正在执行 npm test"`. */
  activity?: string
  /** Name of the tool currently running, when applicable. */
  toolName?: string
  /** Number of tool calls in the current turn. */
  toolCallCount: number
  /** Whether the agent is waiting for permission. */
  needPermission: boolean
  /** Whether the agent is waiting for user input. */
  needUserInput: boolean
  /** Summary of the AI's last message, when captured. */
  lastAssistantMessage?: string
  /** Latest token/context usage, when known. */
  token?: TokenPayload
  /** Epoch millis the current turn started, if a turn is active. */
  turnStartedAt?: number
  /** Epoch millis of the most recent event for this agent. */
  lastEventAt: number
  /** Whether the latest terminal result is still unacknowledged by the user. */
  unread: boolean
}

/**
 * Aggregated tray/overview state derived from all agents (requirements §5.6).
 *
 * Maps directly to a tray icon colour.
 */
export type OverallState =
  | 'idle'
  | 'running'
  | 'attention'
  | 'done_unread'
  | 'error'
  | 'stuck'

/**
 * Snapshot returned by `GET /api/status` and broadcast over the WebSocket.
 *
 * Contains the per-agent states plus the derived {@link OverallState}.
 */
export interface StatusSnapshot {
  /** The aggregated indicator for the tray. */
  overall: OverallState
  /** One entry per agent that has reported activity. */
  agents: AgentRuntimeState[]
  /** Epoch millis the snapshot was built. */
  updatedAt: number
}

/**
 * Minimal status for the future ESP32 / hardware endpoint
 * (`GET /api/device/status`, requirements §5.9). Deliberately flat and small so
 * a microcontroller can parse it cheaply.
 */
export interface DeviceStatus {
  /** Coarse overall state string (e.g. `"waiting_permission"`). */
  mainState: string
  /** The agent currently most relevant, or `null` if idle. */
  activeAgent: AgentType | null
  /** Short message to display on the device. */
  message: string
  /** Claude Code context-used percentage, or `null` if unknown. */
  claudeContext: number | null
  /** Codex's current state string, or `null` if Codex is absent. */
  codexState: string | null
  /** Epoch millis the projection was built. */
  updatedAt: number
}

/**
 * A message pushed to renderer / hardware clients over the WebSocket channel.
 *
 * A discriminated union on `type`: either a fresh status snapshot or a
 * notification request.
 */
export type ServerPushMessage =
  | { type: 'status'; payload: StatusSnapshot }
  | { type: 'notification'; payload: NotificationRequest }

/**
 * Severity levels for desktop notifications (requirements §5.7).
 *
 * - `soft` — silent, informational (e.g. context above 80%).
 * - `normal` — a turn completed.
 * - `strong` — needs the user now (permission/input/error), plays a sound.
 */
export type NotificationLevel = 'soft' | 'normal' | 'strong'

/**
 * A request, produced by the rule engine, to show one notification.
 *
 * The rule engine has already applied throttling/dedup before emitting this;
 * the presentation layer only maps it to the OS notification.
 */
export interface NotificationRequest {
  /** Severity, controlling presentation and sound. */
  level: NotificationLevel
  /** Notification title. */
  title: string
  /** Notification body. */
  body: string
  /** The agent the notification concerns, when applicable. */
  agentType?: AgentType
  /** Stable key the rule engine uses to throttle repeats. */
  dedupeKey: string
  /** Whether a sound should accompany the notification. */
  sound: boolean
  /** Epoch millis the notification was created. */
  createdAt: number
}

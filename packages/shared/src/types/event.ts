/**
 * The normalized internal event vocabulary. Hook scripts POST raw agent-specific
 * payloads; adapters convert them into the {@link AgentEvent} shape defined here,
 * which is the single event type the rest of the system understands
 * (requirements §7.6).
 *
 * @module shared/types/event
 */
import type { AgentType } from './agent.js'
import type { TokenPayload } from './token.js'

/**
 * The closed set of event kinds CodePulse reacts to.
 *
 * Adapters map each agent's native hook events onto one of these.
 */
export type AgentEventType =
  | 'session_start'
  | 'prompt_submit'
  | 'tool_start'
  | 'tool_end'
  | 'permission_request'
  | 'user_input_required'
  | 'turn_stop'
  | 'turn_error'
  | 'token_snapshot'
  | 'session_end'

/**
 * The single internal event shape every adapter normalizes into.
 *
 * Most fields are optional because different event kinds carry different
 * context; the state machine reads whichever fields are relevant to the
 * `eventType`.
 */
export interface AgentEvent {
  /** Unique event id (assigned during normalization if absent). */
  id: string
  /** Which agent emitted the event. */
  source: AgentType
  /** What kind of event this is. */
  eventType: AgentEventType

  /** The agent-assigned session id, when present. */
  externalSessionId?: string
  /** The agent-assigned turn id, when present. */
  externalTurnId?: string
  /** Workspace path reported by the agent. */
  workspacePath?: string
  /** Current working directory reported by the agent. */
  cwd?: string
  /** Model in use, when reported. */
  model?: string
  /** Tool name for `tool_start`/`tool_end`/`permission_request`. */
  toolName?: string
  /** Command line for shell-style tool calls. */
  command?: string
  /** Free-text message (notification text, last assistant message, …). */
  message?: string

  /** Inline token/context usage for `token_snapshot` events. */
  token?: TokenPayload

  /** The original, unmodified payload, retained for debugging/persistence. */
  raw?: unknown
  /** Epoch millis the event occurred (assigned during normalization if absent). */
  timestamp: number
}

/**
 * The shape accepted by `POST /api/events`: an {@link AgentEvent} whose `id` and
 * `timestamp` may be omitted and are filled in by
 * {@link normalizeEvent | the normalizer}.
 */
export type AgentEventInput = Omit<AgentEvent, 'id' | 'timestamp'> & {
  id?: string
  timestamp?: number
}

/**
 * Session and turn types. A session is one agent conversation; a turn is one
 * user-prompt → AI-response cycle within it (requirements §7.3–§7.4).
 *
 * @module shared/types/session
 */
import type { AgentType } from './agent.js'
import type { TurnState } from './state.js'

/**
 * Coarse session lifecycle state, persisted on the session row.
 *
 * This is intentionally simpler than {@link TurnState}: it summarises the whole
 * conversation rather than the fine-grained activity of a single turn.
 */
export type SessionState = 'idle' | 'running' | 'waiting' | 'done' | 'error'

/**
 * One AI agent conversation, possibly spanning many turns.
 *
 * Identified externally by `externalSessionId` (the id the agent itself
 * assigns) and internally by `id`.
 */
export interface Session {
  /** Stable internal identifier. */
  id: string
  /** Which agent owns the session. */
  agentType: AgentType
  /** The session id assigned by the agent itself. */
  externalSessionId: string
  /** The workspace the session is running in. */
  workspaceId: string
  /** Model in use, when known. */
  model?: string
  /** Coarse lifecycle state. */
  state: SessionState
  /** Epoch millis the session started. */
  startedAt: number
  /** Epoch millis the session ended, when finished. */
  endedAt?: number
}

/**
 * A single user-prompt → AI-response cycle (requirements §7.4).
 *
 * Turns are the unit CodePulse notifies on: a turn completing, needing
 * permission, or needing input each map to a notification.
 */
export interface Turn {
  /** Stable internal identifier. */
  id: string
  /** The owning session. */
  sessionId: string
  /** The turn id assigned by the agent, when available. */
  externalTurnId?: string
  /** Fine-grained current state. */
  state: TurnState
  /** Privacy-limited preview of the user's prompt. */
  promptPreview?: string
  /** Epoch millis the turn started. */
  startedAt: number
  /** Epoch millis the turn ended, when finished. */
  endedAt?: number
  /** Number of tool calls observed during the turn. */
  toolCallCount: number
  /** Whether the turn paused for permission. */
  needPermission: boolean
  /** Whether the turn paused for user input. */
  needUserInput: boolean
  /** Summary of the AI's final message, when captured. */
  lastAssistantMessage?: string
}

/**
 * Token / context usage types. CodePulse records how much of an agent's
 * context window and budget a turn has consumed, tagged with how trustworthy
 * the measurement is (requirements §5.4).
 *
 * @module shared/types/token
 */
import type { AgentType } from './agent.js'

/**
 * How trustworthy a token/context measurement is.
 *
 * - `exact` — read from a stable structured source (e.g. Claude's status line).
 * - `estimated` — inferred from a transcript or other heuristic.
 * - `unknown` — currently unavailable.
 */
export type TokenAccuracy = 'exact' | 'estimated' | 'unknown'

/**
 * A point-in-time snapshot of token / context usage, persisted to the database
 * so usage can be charted over a session's lifetime.
 */
export interface TokenSnapshot {
  /** Stable internal identifier. */
  id: string
  /** The owning session. */
  sessionId: string
  /** The turn this snapshot belongs to, when known. */
  turnId?: string
  /** Which agent produced the measurement. */
  agentType: AgentType
  /** Prompt/input tokens, when reported. */
  inputTokens?: number
  /** Completion/output tokens, when reported. */
  outputTokens?: number
  /** Total tokens, when reported. */
  totalTokens?: number
  /** Percentage of the context window used (0–100), when reported. */
  contextUsedPercent?: number
  /** Spend in USD, when reported. */
  costUsd?: number
  /** Confidence in the above figures. */
  accuracy: TokenAccuracy
  /** Epoch millis the snapshot was captured. */
  capturedAt: number
}

/**
 * Compact token payload carried inline on an {@link AgentEvent} and surfaced on
 * {@link AgentRuntimeState}. A trimmed-down {@link TokenSnapshot} without the
 * storage identifiers.
 */
export interface TokenPayload {
  /** Prompt/input tokens. */
  input?: number
  /** Completion/output tokens. */
  output?: number
  /** Total tokens. */
  total?: number
  /** Percentage of the context window used (0–100). */
  contextUsedPercent?: number
  /** Spend in USD. */
  costUsd?: number
  /** Confidence in the figures. */
  accuracy: TokenAccuracy
}

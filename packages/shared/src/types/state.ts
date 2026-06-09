/**
 * The unified turn/agent state machine shared across the whole system. Events
 * from Codex and Claude Code are normalized into transitions between these
 * states (requirements §8).
 *
 * @module shared/types/state
 */

/**
 * Enumerates every state a turn (one prompt → response cycle) can be in.
 *
 * Implemented as a frozen object plus a same-named type so the values can be
 * referenced at runtime (e.g. `TurnState.DONE`) while still being used as a
 * string-literal union in type positions.
 */
export const TurnState = {
  /** No AI task is running. */
  IDLE: 'IDLE',
  /** The user submitted a prompt; the turn has started. */
  PROMPT_SUBMITTED: 'PROMPT_SUBMITTED',
  /** The AI is generating a response or planning. */
  THINKING: 'THINKING',
  /** The AI is executing a tool (read/edit file, run command, …). */
  TOOL_RUNNING: 'TOOL_RUNNING',
  /** The AI is waiting for the user to approve an action. */
  WAITING_PERMISSION: 'WAITING_PERMISSION',
  /** The AI is waiting for the user to continue/clarify. */
  WAITING_USER_INPUT: 'WAITING_USER_INPUT',
  /** The current turn finished successfully. */
  DONE: 'DONE',
  /** The current turn ended in an error. */
  ERROR: 'ERROR',
  /** No new events for a long time — suspected stuck. */
  TIMEOUT: 'TIMEOUT',
  /** The user cancelled the turn. */
  CANCELLED: 'CANCELLED',
} as const

/** String-literal union of every {@link TurnState} value. */
export type TurnState = (typeof TurnState)[keyof typeof TurnState]

/** States in which a turn is still active (not a terminal outcome). */
export const ACTIVE_STATES: readonly TurnState[] = [
  TurnState.PROMPT_SUBMITTED,
  TurnState.THINKING,
  TurnState.TOOL_RUNNING,
  TurnState.WAITING_PERMISSION,
  TurnState.WAITING_USER_INPUT,
]

/** Terminal states — a turn ends when it reaches one of these. */
export const TERMINAL_STATES: readonly TurnState[] = [
  TurnState.DONE,
  TurnState.ERROR,
  TurnState.TIMEOUT,
  TurnState.CANCELLED,
]

/**
 * Reports whether a turn is still in progress.
 *
 * @param state The state to test.
 * @returns `true` if `state` is one of {@link ACTIVE_STATES}.
 */
export function isActiveState(state: TurnState): boolean {
  return ACTIVE_STATES.includes(state)
}

/**
 * Reports whether a turn has reached a terminal outcome.
 *
 * @param state The state to test.
 * @returns `true` if `state` is one of {@link TERMINAL_STATES}.
 */
export function isTerminalState(state: TurnState): boolean {
  return TERMINAL_STATES.includes(state)
}

/**
 * Reports whether a state requires the user to step in.
 *
 * Drives the "attention" tray colour and strong notifications.
 *
 * @param state The state to test.
 * @returns `true` for `WAITING_PERMISSION` or `WAITING_USER_INPUT`.
 */
export function needsUserAttention(state: TurnState): boolean {
  return state === TurnState.WAITING_PERMISSION || state === TurnState.WAITING_USER_INPUT
}

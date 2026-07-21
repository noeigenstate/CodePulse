/**
 * A native CLI observation of one task's timing lifecycle.
 *
 * Unlike the timestamp on a CodePulse event, these values come from the CLI's
 * persisted session data. That distinction lets the dashboard recover an
 * elapsed time after CodePulse restarts or misses a lifecycle hook.
 *
 * @module shared/types/timing
 */

/**
 * Whether a {@link TurnTiming} snapshot is still advancing or has frozen.
 */
export type TurnTimingState = 'active' | 'completed'

/**
 * A timestamped duration snapshot for the current or most recently ended turn.
 */
export interface TurnTiming {
  /** Whether elapsed time is still advancing or has reached a terminal value. */
  state: TurnTimingState
  /** CLI-assigned identity of the native task represented by this timing. */
  externalTurnId?: string
  /** Whether this terminal snapshot may close an already-active visible turn. */
  canEndActiveTurn?: boolean
  /** Terminal result when a frozen duration represents cancellation rather than success. */
  outcome?: 'completed' | 'cancelled'
  /** Native start time in epoch milliseconds, when the CLI records one. */
  startedAt?: number
  /** Frozen native or derived elapsed milliseconds for an ended turn. */
  elapsedMs?: number
  /** Time of the newest native timing evidence, in epoch milliseconds. */
  observedAt: number
}

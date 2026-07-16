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
 * The lifecycle state represented by a {@link TurnTiming} snapshot.
 */
export type TurnTimingState = 'active' | 'completed'

/**
 * A timestamped duration snapshot for the current or most recently completed turn.
 */
export interface TurnTiming {
  /** Whether the CLI still considers the observed turn active or has completed it. */
  state: TurnTimingState
  /** Native start time in epoch milliseconds, when the CLI records one. */
  startedAt?: number
  /** Frozen native or derived elapsed milliseconds for a completed turn. */
  elapsedMs?: number
  /** Time of the newest native timing evidence, in epoch milliseconds. */
  observedAt: number
}

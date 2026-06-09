/**
 * The {@link StatusHub} — the in-memory brain that ties the reducer and rule
 * engine together and exposes a small event API the rest of the app subscribes
 * to. It holds one runtime state per agent and is intentionally
 * framework-agnostic (no Electron, HTTP, or DB dependency).
 *
 * @module core/hub
 */
import { EventEmitter } from 'node:events'
import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  type NotificationRequest,
  type StatusSnapshot,
} from '@codepulse/shared'
import { buildStatusSnapshot } from '../aggregate/index.js'
import { createInitialRuntimeState, reduce } from '../state-machine/index.js'
import { RuleEngine, type RuleEngineOptions } from '../rule-engine/index.js'

/**
 * The typed events a {@link StatusHub} emits.
 */
export interface StatusHubEvents {
  /** Every persisted, normalized event (consumed by storage/logging). */
  event: (event: AgentEvent) => void
  /** Emitted whenever the aggregated status changes. */
  status: (snapshot: StatusSnapshot) => void
  /** Emitted when the rule engine decides a notification should fire. */
  notification: (notification: NotificationRequest) => void
}

/**
 * The in-memory brain of CodePulse.
 *
 * Feed it normalized events via {@link ingest}; it applies the state-machine
 * reducer, runs the rule engine, and emits `event` / `status` / `notification`
 * for the Electron main process (or any host) to act on. Because it carries no
 * platform dependencies it can also be driven directly in tests.
 */
export class StatusHub extends EventEmitter {
  /** Current runtime state, one slot per agent. */
  private agents = new Map<AgentType, AgentRuntimeState>()
  /** The shared, stateful notification rule engine. */
  private rules: RuleEngine
  /** Handle for the inactivity watchdog interval, when running. */
  private tickTimer?: NodeJS.Timeout

  /**
   * @param options Rule-engine tuning (throttling, initial mute state).
   */
  constructor(options: RuleEngineOptions = {}) {
    super()
    this.rules = new RuleEngine(options)
  }

  /**
   * Feeds one normalized event through the state machine and rule engine.
   *
   * Emits `event` (always), `status` (always — the snapshot may be unchanged but
   * subscribers re-render cheaply), and `notification` for each rule that fired.
   *
   * @param event The normalized event to apply.
   */
  ingest(event: AgentEvent): void {
    const current = this.agents.get(event.source) ?? createInitialRuntimeState(event.source)
    const result = reduce(current, event)
    this.agents.set(event.source, result.next)

    this.emit('event', event)
    this.emit('status', this.snapshot())

    for (const note of this.rules.onTransition(result, event.timestamp)) {
      this.emit('notification', note)
    }
  }

  /**
   * Marks an agent's latest terminal result as acknowledged, clearing the tray
   * "unread" badge. No-op if there is nothing unread.
   *
   * @param agentType The agent to acknowledge.
   */
  acknowledge(agentType: AgentType): void {
    const current = this.agents.get(agentType)
    if (!current || !current.unread) return
    this.agents.set(agentType, { ...current, unread: false })
    this.emit('status', this.snapshot())
  }

  /**
   * Enables or disables notification sound globally.
   *
   * @param muted `true` to suppress sound.
   */
  setMuted(muted: boolean): void {
    this.rules.setMuted(muted)
  }

  /**
   * Builds the current aggregated status snapshot.
   *
   * @param now Current time in epoch millis (injectable for testing).
   * @returns The snapshot of all agents plus the overall indicator.
   */
  snapshot(now = Date.now()): StatusSnapshot {
    return buildStatusSnapshot([...this.agents.values()], now)
  }

  /**
   * Starts the inactivity ("疑似卡住") watchdog. Safe to call repeatedly; any
   * existing timer is replaced. The timer is `unref`'d so it never keeps the
   * process alive on its own.
   *
   * @param intervalMs How often to run the stuck check, in ms.
   */
  startWatchdog(intervalMs = 30_000): void {
    this.stopWatchdog()
    this.tickTimer = setInterval(() => this.tick(), intervalMs)
    this.tickTimer.unref?.()
  }

  /** Stops the inactivity watchdog if running. */
  stopWatchdog(): void {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  /**
   * One watchdog iteration: runs the stuck check for every agent and emits any
   * resulting notifications (plus a `status` update if anything changed).
   *
   * @param now Current time in epoch millis (injectable for testing).
   */
  private tick(now = Date.now()): void {
    let changed = false
    for (const agent of this.agents.values()) {
      for (const note of this.rules.onTick(agent, now)) {
        this.emit('notification', note)
        changed = true
      }
    }
    if (changed) this.emit('status', this.snapshot(now))
  }

  // Typed event helpers ------------------------------------------------------

  /**
   * Type-safe {@link EventEmitter.on} restricted to {@link StatusHubEvents}.
   *
   * @param event The event name.
   * @param listener The strongly-typed listener for that event.
   * @returns This hub, for chaining.
   */
  override on<E extends keyof StatusHubEvents>(event: E, listener: StatusHubEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void)
  }

  /**
   * Type-safe {@link EventEmitter.emit} restricted to {@link StatusHubEvents}.
   *
   * @param event The event name.
   * @param args The strongly-typed arguments for that event.
   * @returns `true` if the event had listeners.
   */
  override emit<E extends keyof StatusHubEvents>(
    event: E,
    ...args: Parameters<StatusHubEvents[E]>
  ): boolean {
    return super.emit(event, ...args)
  }
}

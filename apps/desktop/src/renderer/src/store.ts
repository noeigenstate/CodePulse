/**
 * The renderer's Zustand store. Holds the latest status snapshot, mute state,
 * and recent notifications, and bridges to the main process via the
 * `window.codepulse` preload API.
 *
 * @module renderer/store
 */
import { create } from 'zustand'
import type { AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

/** Snapshot used before the first real status arrives. */
const EMPTY_SNAPSHOT: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

/**
 * The store's state shape and actions.
 */
interface CodePulseStore {
  /** Whether the initial status has loaded. */
  ready: boolean
  /** The latest status snapshot. */
  snapshot: StatusSnapshot
  /** Whether notification sound is muted. */
  muted: boolean
  /** Recent notifications, newest first (capped). */
  notifications: NotificationRequest[]
  /**
   * Loads the initial status and subscribes to pushes.
   *
   * @returns A cleanup function that removes all subscriptions.
   */
  init: () => () => void
  /** Acknowledges one agent's unread result. */
  ack: (agent: AgentType) => void
  /** Acknowledges all agents and clears the local notification list. */
  clearAlerts: () => void
  /** Toggles mute and pushes the new value to the main process. */
  toggleMute: () => void
  /** Removes one notification from the local list by its dedupe key. */
  dismissNotification: (dedupeKey: string) => void
}

/**
 * The shared store hook. A single instance backs the whole renderer.
 */
export const useStore = create<CodePulseStore>((set, get) => ({
  ready: false,
  snapshot: EMPTY_SNAPSHOT,
  muted: false,
  notifications: [],

  init: () => {
    const api = window.codepulse
    void api.getStatus().then((snapshot) => set({ snapshot, ready: true }))

    const offStatus = api.onStatus((snapshot) => set({ snapshot }))
    const offMute = api.onMute((muted) => set({ muted }))
    const offNote = api.onNotification((note) =>
      set((s) => ({ notifications: [note, ...s.notifications].slice(0, 30) })),
    )

    return () => {
      offStatus()
      offMute()
      offNote()
    }
  },

  ack: (agent) => {
    void window.codepulse.ack(agent)
  },

  clearAlerts: () => {
    void window.codepulse.clearAlerts()
    set({ notifications: [] })
  },

  toggleMute: () => {
    const next = !get().muted
    set({ muted: next })
    void window.codepulse.setMute(next)
  },

  dismissNotification: (dedupeKey) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.dedupeKey !== dedupeKey) })),
}))

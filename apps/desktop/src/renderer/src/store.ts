import { create } from 'zustand'
import type { Agent, AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'
import { sameSnapshotData } from './lib/snapshotKey.js'

const EMPTY_SNAPSHOT: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

interface CodePulseStore {
  ready: boolean
  snapshot: StatusSnapshot
  muted: boolean
  agents: Agent[]
  notifications: NotificationRequest[]
  init: () => () => void
  ack: (agent: AgentType, workspacePath?: string) => void
  toggleMute: () => void
  dismissNotification: (dedupeKey: string, createdAt: number) => void
}

export const useStore = create<CodePulseStore>((set, get) => ({
  ready: false,
  snapshot: EMPTY_SNAPSHOT,
  muted: false,
  agents: [],
  notifications: [],

  init: () => {
    const api = window.codepulse
    if (!api) {
      set({ ready: true })
      return () => undefined
    }

    const applySnapshot = (snapshot: StatusSnapshot, ready = false): void => {
      set((state) => {
        const nextReady = ready || state.ready
        if (sameSnapshotData(state.snapshot, snapshot)) {
          return state.ready === nextReady ? state : { ready: nextReady }
        }
        return { snapshot, ready: nextReady }
      })
    }

    void api.getStatus().then((snapshot) => applySnapshot(snapshot, true))
    void api.detectAgents().then((agents) => set({ agents }))

    const offStatus = api.onStatus((snapshot) => applySnapshot(snapshot))
    const offMute = api.onMute((muted) => set({ muted }))
    const offNote = api.onNotification((note) =>
      set((state) => {
        const key = `${note.dedupeKey}-${note.createdAt}`
        const existing = new Set(state.notifications.map((n) => `${n.dedupeKey}-${n.createdAt}`))
        if (existing.has(key)) return state
        return { notifications: [note, ...state.notifications].slice(0, 30) }
      }),
    )

    return () => {
      offStatus()
      offMute()
      offNote()
    }
  },

  ack: (agent, workspacePath) => {
    void window.codepulse.ack(agent, workspacePath)
  },

  toggleMute: () => {
    const next = !get().muted
    set({ muted: next })
    void window.codepulse.setMute(next)
  },

  dismissNotification: (dedupeKey, createdAt) =>
    set((state) => ({
      notifications: state.notifications.filter(
        (note) => note.dedupeKey !== dedupeKey || note.createdAt !== createdAt,
      ),
    })),
}))

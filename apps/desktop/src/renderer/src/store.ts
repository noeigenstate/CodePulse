import { create } from 'zustand'
import type { Agent, AgentType, StatusSnapshot } from '@codepulse/shared'
import { sameSnapshotData } from './lib/snapshotKey.js'

const EMPTY_SNAPSHOT: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

interface CodePulseStore {
  ready: boolean
  snapshot: StatusSnapshot
  muted: boolean
  agents: Agent[]
  init: () => () => void
  ack: (agent: AgentType, workspacePath?: string) => void
  toggleMute: () => void
}

export const useStore = create<CodePulseStore>((set, get) => ({
  ready: false,
  snapshot: EMPTY_SNAPSHOT,
  muted: false,
  agents: [],

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

    return () => {
      offStatus()
      offMute()
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
}))

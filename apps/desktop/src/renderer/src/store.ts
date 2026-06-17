import { create } from 'zustand'
import type { Agent, AgentType, StatusSnapshot, UpdateInfo } from '@codepulse/shared'
import { sameSnapshotData } from './lib/snapshotKey.js'

const EMPTY_SNAPSHOT: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

interface CodePulseStore {
  ready: boolean
  snapshot: StatusSnapshot
  muted: boolean
  agents: Agent[]
  agentCheckId: number
  updateInfo: UpdateInfo | null
  updateInstalling: boolean
  updateError?: string
  init: () => () => void
  ack: (agent: AgentType, workspacePath?: string) => void
  toggleMute: () => void
  dismissUpdate: () => void
  installUpdate: () => void
}

export const useStore = create<CodePulseStore>((set, get) => ({
  ready: false,
  snapshot: EMPTY_SNAPSHOT,
  muted: false,
  agents: [],
  agentCheckId: 0,
  updateInfo: null,
  updateInstalling: false,
  updateError: undefined,

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

    const applyAgents = (agents: Agent[]): void => {
      set((state) => ({ agents, agentCheckId: state.agentCheckId + 1 }))
    }

    void api.getStatus().then((snapshot) => applySnapshot(snapshot, true))
    void api.detectAgents().then(applyAgents)
    void api.getUpdate().then((updateInfo) => {
      if (updateInfo) set({ updateInfo, updateError: undefined })
    })

    const offStatus = api.onStatus((snapshot) => applySnapshot(snapshot))
    const offMute = api.onMute((muted) => set({ muted }))
    const offAgents = api.onAgents(applyAgents)
    const offUpdate = api.onUpdateAvailable((updateInfo) =>
      set({ updateInfo, updateError: undefined }),
    )

    return () => {
      offStatus()
      offMute()
      offAgents()
      offUpdate()
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

  dismissUpdate: () => {
    set({ updateInfo: null, updateError: undefined, updateInstalling: false })
  },

  installUpdate: () => {
    const update = get().updateInfo
    if (!update || get().updateInstalling) return

    set({ updateInstalling: true, updateError: undefined })
    void window.codepulse.installUpdate().then((result) => {
      if (result.ok) {
        set({ updateInstalling: false, updateInfo: null, updateError: undefined })
        return
      }
      set({ updateInstalling: false, updateError: result.error })
    })
  },
}))

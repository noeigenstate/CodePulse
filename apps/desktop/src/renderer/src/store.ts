import { create } from 'zustand'
import type {
  Agent,
  AgentType,
  StatusSnapshot,
  UpdateDownloadProgress,
  UpdateInfo,
} from '@codepulse/shared'
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
  updateProgress?: UpdateDownloadProgress
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
  updateProgress: undefined,
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

    // Prefer an active disk rescan so cards fill even when hooks never fired.
    // Fall back to getStatus if preload is older than this build.
    const bootstrapStatus = api.syncSessions
      ? api.syncSessions().catch(() => api.getStatus())
      : api.getStatus()
    void bootstrapStatus.then((snapshot) => applySnapshot(snapshot, true))
    void api.detectAgents().then(applyAgents)
    void api.getUpdate().then((updateInfo) => {
      if (updateInfo) set({ updateInfo, updateError: undefined })
    })

    const offStatus = api.onStatus((snapshot) => applySnapshot(snapshot))
    const offMute = api.onMute((muted) => set({ muted }))
    const offAgents = api.onAgents(applyAgents)
    const offUpdate = api.onUpdateAvailable((updateInfo) =>
      set({ updateInfo, updateError: undefined, updateProgress: undefined }),
    )
    const offUpdateProgress = api.onUpdateProgress((updateProgress) => set({ updateProgress }))

    return () => {
      offStatus()
      offMute()
      offAgents()
      offUpdate()
      offUpdateProgress()
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
    // Persist 24h snooze in main so the hourly background check stays silent.
    void window.codepulse.dismissUpdate()
    set({
      updateInfo: null,
      updateError: undefined,
      updateInstalling: false,
      updateProgress: undefined,
    })
  },

  installUpdate: () => {
    const update = get().updateInfo
    if (!update || get().updateInstalling) return

    set({
      updateInstalling: true,
      updateError: undefined,
      updateProgress: { phase: 'preparing', received: 0, percent: 0 },
    })
    void window.codepulse.installUpdate().then((result) => {
      if (result.ok) {
        // App usually exits right after launching the installer; keep the modal on
        // the launch phase until then so the install bar does not disappear first.
        set({
          updateInstalling: true,
          updateProgress: { phase: 'launching', received: 0, percent: 100 },
          updateError: undefined,
        })
        return
      }
      set({ updateInstalling: false, updateError: result.error, updateProgress: undefined })
    })
  },
}))

import { create } from 'zustand'
import type {
  Agent,
  AgentType,
  StatusSnapshot,
  UpdateDownloadProgress,
  UpdateInfo,
} from '@codepulse/shared'
import { snapshotDataKey } from './lib/snapshotKey.js'

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

    let disposed = false
    let statusReceived = false
    let agentsReceived = false
    let updateReceived = false
    let keyedSnapshot = get().snapshot
    let currentSnapshotKey = snapshotDataKey(keyedSnapshot)

    /**
     * Applies semantic snapshot changes while caching the retained snapshot's key.
     *
     * @param snapshot New snapshot received from the preload bridge.
     * @param ready Whether this observation completes renderer initialization.
     */
    const applySnapshot = (snapshot: StatusSnapshot, ready = false): void => {
      if (disposed) return
      set((state) => {
        if (state.snapshot !== keyedSnapshot) {
          keyedSnapshot = state.snapshot
          currentSnapshotKey = snapshotDataKey(keyedSnapshot)
        }
        const incomingKey =
          snapshot === keyedSnapshot ? currentSnapshotKey : snapshotDataKey(snapshot)
        const nextReady = ready || state.ready
        if (currentSnapshotKey === incomingKey) {
          return state.ready === nextReady ? state : { ready: nextReady }
        }
        keyedSnapshot = snapshot
        currentSnapshotKey = incomingKey
        return { snapshot, ready: nextReady }
      })
    }

    /**
     * Applies CLI detection results only while the renderer subscription is active.
     *
     * @param agents Supported CLI records from the main process.
     */
    const applyAgents = (agents: Agent[]): void => {
      if (disposed) return
      set((state) => ({ agents, agentCheckId: state.agentCheckId + 1 }))
    }

    // Register push listeners first so updates during bootstrap cannot be missed
    // or replaced by a slower response from an older renderer lifetime.
    const offStatus = api.onStatus((snapshot) => {
      statusReceived = true
      applySnapshot(snapshot, true)
    })
    const offMute = api.onMute((muted) => {
      if (!disposed) set({ muted })
    })
    const offAgents = api.onAgents((agents) => {
      agentsReceived = true
      applyAgents(agents)
    })
    const offUpdate = api.onUpdateAvailable((updateInfo) => {
      updateReceived = true
      if (!disposed) set({ updateInfo, updateError: undefined, updateProgress: undefined })
    })
    const offUpdateProgress = api.onUpdateProgress((updateProgress) => {
      if (!disposed) set({ updateProgress })
    })

    // Prefer an active disk rescan so cards fill even when hooks never fired.
    // Fall back to getStatus if preload is older than this build.
    const bootstrapStatus = api.syncSessions
      ? api.syncSessions().catch(() => api.getStatus())
      : api.getStatus()
    void bootstrapStatus
      .then((snapshot) => {
        if (!statusReceived) applySnapshot(snapshot, true)
      })
      .catch(() => {
        if (!disposed) set({ ready: true })
      })
    void api
      .detectAgents()
      .then((agents) => {
        if (!agentsReceived) applyAgents(agents)
      })
      .catch(() => undefined)
    void api
      .getUpdate()
      .then((updateInfo) => {
        if (!disposed && !updateReceived && updateInfo) set({ updateInfo, updateError: undefined })
      })
      .catch(() => undefined)

    return () => {
      disposed = true
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

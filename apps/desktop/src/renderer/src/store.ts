/**
 * 渲染端的 Zustand store。持有最新状态快照、静音状态与最近通知，
 * 并通过 `window.codepulse` preload API 与主进程桥接。
 *
 * @module renderer/store
 */
import { create } from 'zustand'
import type { Agent, AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

/** 首个真实状态到达前使用的快照。 */
const EMPTY_SNAPSHOT: StatusSnapshot = { overall: 'idle', agents: [], updatedAt: Date.now() }

/**
 * store 的状态形态与动作。
 */
interface CodePulseStore {
  /** 初始状态是否已加载。 */
  ready: boolean
  /** 最新的状态快照。 */
  snapshot: StatusSnapshot
  /** 通知声音是否静音。 */
  muted: boolean
  /** 本地 CLI/hook 检测结果。 */
  agents: Agent[]
  /** 最近的通知，新者在前（有上限）。 */
  notifications: NotificationRequest[]
  /**
   * 加载初始状态并订阅推送。
   *
   * @returns 移除所有订阅的清理函数。
   */
  init: () => () => void
  /** 确认某个 agent 的未读结果。 */
  ack: (agent: AgentType, workspacePath?: string) => void
  /** 确认所有 agent 并清空本地通知列表。 */
  clearAlerts: () => void
  /** 切换静音并把新值推送给主进程。 */
  toggleMute: () => void
  /** 按去重键从本地列表移除一条通知。 */
  dismissNotification: (dedupeKey: string, createdAt: number) => void
}

/**
 * 共享的 store hook。整个渲染端由单个实例支撑。
 */
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

    void api.getStatus().then((snapshot) => set({ snapshot, ready: true }))
    void api.detectAgents().then((agents) => set({ agents }))

    const offStatus = api.onStatus((snapshot) => set({ snapshot }))
    const offMute = api.onMute((muted) => set({ muted }))
    const offNote = api.onNotification((note) =>
      set((s) => {
        const key = `${note.dedupeKey}-${note.createdAt}`
        const existing = new Set(s.notifications.map((n) => `${n.dedupeKey}-${n.createdAt}`))
        if (existing.has(key)) return s
        return { notifications: [note, ...s.notifications].slice(0, 30) }
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

  clearAlerts: () => {
    void window.codepulse.clearAlerts()
    set({ notifications: [] })
  },

  toggleMute: () => {
    const next = !get().muted
    set({ muted: next })
    void window.codepulse.setMute(next)
  },

  dismissNotification: (dedupeKey, createdAt) =>
    set((s) => ({
      notifications: s.notifications.filter(
        (n) => n.dedupeKey !== dedupeKey || n.createdAt !== createdAt,
      ),
    })),
}))

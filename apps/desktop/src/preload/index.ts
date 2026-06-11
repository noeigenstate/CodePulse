/**
 * Preload 脚本。通过 Electron 的 context bridge 向渲染端暴露一个
 * 小型、有类型的 `window.codepulse` API，使 Dashboard 无需直接访问
 * `ipcRenderer` 即可读取状态、确认结果、切换静音并订阅推送。
 *
 * @module preload
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Agent, AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

/** 用于移除先前注册的订阅的函数。 */
type Unsubscribe = () => void

/**
 * 订阅一个 IPC 通道并返回取消订阅函数。
 *
 * @param channel 要监听的 IPC 通道。
 * @param cb 对每条消息载荷调用。
 * @returns 移除监听器的函数。
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * 以 `window.codepulse` 暴露给渲染端的 API 面。
 *
 * 请求/响应方法封装 `ipcRenderer.invoke`；`on*` 方法注册推送订阅
 * 并返回取消订阅函数。
 */
const api = {
  /** 获取当前状态快照。 */
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:get-status'),
  /** 确认某 agent 的未读终结结果。 */
  ack: (agent: AgentType): Promise<boolean> => ipcRenderer.invoke('codepulse:ack', agent),
  /** 确认所有 agent 的未读结果。 */
  clearAlerts: (): Promise<boolean> => ipcRenderer.invoke('codepulse:clear-alerts'),
  /** 设置静音状态；解析为实际应用的值。 */
  setMute: (muted: boolean): Promise<boolean> => ipcRenderer.invoke('codepulse:set-mute', muted),
  /** 返回本地服务器的 host/port。 */
  serverInfo: (): Promise<{ host: string; port: number }> =>
    ipcRenderer.invoke('codepulse:server-info'),
  /** 检测本地 agent 的 CLI/hook 配置。 */
  detectAgents: (): Promise<Agent[]> => ipcRenderer.invoke('codepulse:detect-agents'),
  /** 订阅状态快照。 */
  onStatus: (cb: (snapshot: StatusSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:status', cb),
  /** 订阅通知请求。 */
  onNotification: (cb: (note: NotificationRequest) => void): Unsubscribe =>
    subscribe('codepulse:notification', cb),
  /** 订阅静音状态变化。 */
  onMute: (cb: (muted: boolean) => void): Unsubscribe => subscribe('codepulse:mute', cb),
  /** 订阅导航请求（例如托盘「设置」）。 */
  onNavigate: (cb: (route: string) => void): Unsubscribe => subscribe('codepulse:navigate', cb),
}

/** {@link api} 对象的类型，在渲染端 `env.d.ts` 中重新声明。 */
export type CodePulseApi = typeof api

contextBridge.exposeInMainWorld('codepulse', api)

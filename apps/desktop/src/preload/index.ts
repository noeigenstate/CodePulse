/**
 * Preload script. Exposes a small, typed `window.codepulse` API to the renderer
 * over Electron's context bridge, so the Dashboard can read status, acknowledge
 * results, toggle mute, and subscribe to pushes without direct `ipcRenderer`
 * access.
 *
 * @module preload
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

/** A function that removes a previously-registered subscription. */
type Unsubscribe = () => void

/**
 * Subscribes to an IPC channel and returns an unsubscribe function.
 *
 * @param channel The IPC channel to listen on.
 * @param cb Invoked with each message payload.
 * @returns A function that removes the listener.
 */
function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/**
 * The API surface exposed to the renderer as `window.codepulse`.
 *
 * Request/response methods wrap `ipcRenderer.invoke`; the `on*` methods register
 * push subscriptions and return unsubscribe functions.
 */
const api = {
  /** Fetches the current status snapshot. */
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:get-status'),
  /** Acknowledges an agent's unread terminal result. */
  ack: (agent: AgentType): Promise<boolean> => ipcRenderer.invoke('codepulse:ack', agent),
  /** Acknowledges all agents' unread results. */
  clearAlerts: (): Promise<boolean> => ipcRenderer.invoke('codepulse:clear-alerts'),
  /** Sets the mute state; resolves to the applied value. */
  setMute: (muted: boolean): Promise<boolean> => ipcRenderer.invoke('codepulse:set-mute', muted),
  /** Returns the local server's host/port. */
  serverInfo: (): Promise<{ host: string; port: number }> =>
    ipcRenderer.invoke('codepulse:server-info'),
  /** Subscribes to status snapshots. */
  onStatus: (cb: (snapshot: StatusSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:status', cb),
  /** Subscribes to notification requests. */
  onNotification: (cb: (note: NotificationRequest) => void): Unsubscribe =>
    subscribe('codepulse:notification', cb),
  /** Subscribes to mute-state changes. */
  onMute: (cb: (muted: boolean) => void): Unsubscribe => subscribe('codepulse:mute', cb),
  /** Subscribes to navigation requests (e.g. tray "设置"). */
  onNavigate: (cb: (route: string) => void): Unsubscribe => subscribe('codepulse:navigate', cb),
}

/** The type of the {@link api} object, re-declared in the renderer's `env.d.ts`. */
export type CodePulseApi = typeof api

contextBridge.exposeInMainWorld('codepulse', api)

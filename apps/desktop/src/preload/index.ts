import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  Agent,
  AgentType,
  DeviceProvisioningRequest,
  DeviceProvisioningSnapshot,
  StatusSnapshot,
  UiLocale,
  UpdateDownloadProgress,
  UpdateInfo,
  UpdateInstallResult,
  UsageStatsQuery,
  UsageStatsSnapshot,
} from '@codepulse/shared'

type Unsubscribe = () => void
/** Theme values accepted by the native window chrome bridge. */
type WindowTheme = 'light' | 'dark'

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  /** Lets the renderer opt into Windows-only title-bar layout without Node access. */
  platform: process.platform,
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:get-status'),
  ack: (agent: AgentType, workspacePath?: string): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:ack', agent, workspacePath),
  setMute: (muted: boolean): Promise<boolean> => ipcRenderer.invoke('codepulse:set-mute', muted),
  setLocale: (locale: UiLocale): Promise<UiLocale> =>
    ipcRenderer.invoke('codepulse:set-locale', locale),
  /** Keeps native window controls aligned with the renderer's selected palette. */
  setWindowTheme: (theme: WindowTheme): Promise<WindowTheme> =>
    ipcRenderer.invoke('codepulse:set-window-theme', theme),
  detectAgents: (): Promise<Agent[]> => ipcRenderer.invoke('codepulse:detect-agents'),
  getUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('codepulse:get-update'),
  /** User dismissed the update modal — main process snoozes checks for 24h. */
  dismissUpdate: (): Promise<boolean> => ipcRenderer.invoke('codepulse:dismiss-update'),
  installUpdate: (): Promise<UpdateInstallResult> => ipcRenderer.invoke('codepulse:install-update'),
  getStats: (query?: UsageStatsQuery): Promise<UsageStatsSnapshot> =>
    ipcRenderer.invoke('codepulse:get-stats', query),
  /** 主动扫本机 Codex/Grok 会话目录，返回最新 StatusHub 快照。 */
  syncSessions: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:sync-sessions'),
  getDeviceProvisioning: (): Promise<DeviceProvisioningSnapshot> =>
    ipcRenderer.invoke('codepulse:get-device-provisioning'),
  startDeviceScan: (): Promise<DeviceProvisioningSnapshot> =>
    ipcRenderer.invoke('codepulse:start-device-scan'),
  stopDeviceScan: (): Promise<DeviceProvisioningSnapshot> =>
    ipcRenderer.invoke('codepulse:stop-device-scan'),
  provisionDevice: (request: DeviceProvisioningRequest): Promise<DeviceProvisioningSnapshot> =>
    ipcRenderer.invoke('codepulse:provision-device', request),
  cancelDeviceProvisioning: (): Promise<DeviceProvisioningSnapshot> =>
    ipcRenderer.invoke('codepulse:cancel-device-provisioning'),
  onStatus: (cb: (snapshot: StatusSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:status', cb),
  onAgents: (cb: (agents: Agent[]) => void): Unsubscribe => subscribe('codepulse:agents', cb),
  onMute: (cb: (muted: boolean) => void): Unsubscribe => subscribe('codepulse:mute', cb),
  onUpdateAvailable: (cb: (update: UpdateInfo) => void): Unsubscribe =>
    subscribe('codepulse:update-available', cb),
  onUpdateProgress: (cb: (progress: UpdateDownloadProgress) => void): Unsubscribe =>
    subscribe('codepulse:update-progress', cb),
  onDeviceProvisioning: (cb: (snapshot: DeviceProvisioningSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:device-provisioning', cb),
}

export type CodePulseApi = typeof api

contextBridge.exposeInMainWorld('codepulse', api)

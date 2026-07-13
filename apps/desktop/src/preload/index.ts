import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  Agent,
  AgentType,
  StatusSnapshot,
  UpdateDownloadProgress,
  UpdateInfo,
  UpdateInstallResult,
} from '@codepulse/shared'

type Unsubscribe = () => void

function subscribe<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_event: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:get-status'),
  ack: (agent: AgentType, workspacePath?: string): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:ack', agent, workspacePath),
  setMute: (muted: boolean): Promise<boolean> => ipcRenderer.invoke('codepulse:set-mute', muted),
  detectAgents: (): Promise<Agent[]> => ipcRenderer.invoke('codepulse:detect-agents'),
  getUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('codepulse:get-update'),
  installUpdate: (): Promise<UpdateInstallResult> => ipcRenderer.invoke('codepulse:install-update'),
  onStatus: (cb: (snapshot: StatusSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:status', cb),
  onAgents: (cb: (agents: Agent[]) => void): Unsubscribe => subscribe('codepulse:agents', cb),
  onMute: (cb: (muted: boolean) => void): Unsubscribe => subscribe('codepulse:mute', cb),
  onUpdateAvailable: (cb: (update: UpdateInfo) => void): Unsubscribe =>
    subscribe('codepulse:update-available', cb),
  onUpdateProgress: (cb: (progress: UpdateDownloadProgress) => void): Unsubscribe =>
    subscribe('codepulse:update-progress', cb),
}

export type CodePulseApi = typeof api

contextBridge.exposeInMainWorld('codepulse', api)

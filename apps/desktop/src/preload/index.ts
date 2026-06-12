import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { Agent, AgentType, StatusSnapshot } from '@codepulse/shared'

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
  onStatus: (cb: (snapshot: StatusSnapshot) => void): Unsubscribe =>
    subscribe('codepulse:status', cb),
  onMute: (cb: (muted: boolean) => void): Unsubscribe => subscribe('codepulse:mute', cb),
}

export type CodePulseApi = typeof api

contextBridge.exposeInMainWorld('codepulse', api)

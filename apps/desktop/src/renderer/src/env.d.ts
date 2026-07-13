/// <reference types="vite/client" />
import type {
  Agent,
  AgentType,
  StatusSnapshot,
  UpdateDownloadProgress,
  UpdateInfo,
  UpdateInstallResult,
} from '@codepulse/shared'

type Unsubscribe = () => void

/** 镜像 src/preload/index.ts 通过 contextBridge 暴露的 API。 */
export interface CodePulseApi {
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType, workspacePath?: string) => Promise<boolean>
  setMute: (muted: boolean) => Promise<boolean>
  detectAgents: () => Promise<Agent[]>
  getUpdate: () => Promise<UpdateInfo | null>
  installUpdate: () => Promise<UpdateInstallResult>
  onStatus: (cb: (snapshot: StatusSnapshot) => void) => Unsubscribe
  onAgents: (cb: (agents: Agent[]) => void) => Unsubscribe
  onMute: (cb: (muted: boolean) => void) => Unsubscribe
  onUpdateAvailable: (cb: (update: UpdateInfo) => void) => Unsubscribe
  onUpdateProgress: (cb: (progress: UpdateDownloadProgress) => void) => Unsubscribe
}

declare global {
  interface Window {
    codepulse: CodePulseApi
  }
}

export {}

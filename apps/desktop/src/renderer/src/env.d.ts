/// <reference types="vite/client" />
import type { Agent, AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

type Unsubscribe = () => void

/** 镜像 src/preload/index.ts 通过 contextBridge 暴露的 API。 */
export interface CodePulseApi {
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType) => Promise<boolean>
  clearAlerts: () => Promise<boolean>
  setMute: (muted: boolean) => Promise<boolean>
  serverInfo: () => Promise<{ host: string; port: number }>
  detectAgents: () => Promise<Agent[]>
  onStatus: (cb: (snapshot: StatusSnapshot) => void) => Unsubscribe
  onNotification: (cb: (note: NotificationRequest) => void) => Unsubscribe
  onMute: (cb: (muted: boolean) => void) => Unsubscribe
  onNavigate: (cb: (route: string) => void) => Unsubscribe
}

declare global {
  interface Window {
    codepulse: CodePulseApi
  }
}

export {}

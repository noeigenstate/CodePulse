/// <reference types="vite/client" />
import type { AgentType, NotificationRequest, StatusSnapshot } from '@codepulse/shared'

type Unsubscribe = () => void

/** Mirrors the API exposed by src/preload/index.ts via contextBridge. */
export interface CodePulseApi {
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType) => Promise<boolean>
  clearAlerts: () => Promise<boolean>
  setMute: (muted: boolean) => Promise<boolean>
  serverInfo: () => Promise<{ host: string; port: number }>
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

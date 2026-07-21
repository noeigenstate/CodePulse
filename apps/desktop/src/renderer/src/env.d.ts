/// <reference types="vite/client" />
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

/** 镜像 src/preload/index.ts 通过 contextBridge 暴露的 API。 */
export interface CodePulseApi {
  /** Host platform exposed by the constrained preload bridge. */
  platform: NodeJS.Platform
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType, workspacePath?: string) => Promise<boolean>
  setMute: (muted: boolean) => Promise<boolean>
  setLocale: (locale: UiLocale) => Promise<UiLocale>
  /** Synchronizes native title-bar colors with the resolved renderer theme. */
  setWindowTheme: (theme: WindowTheme) => Promise<WindowTheme>
  detectAgents: () => Promise<Agent[]>
  getUpdate: () => Promise<UpdateInfo | null>
  dismissUpdate: () => Promise<boolean>
  installUpdate: () => Promise<UpdateInstallResult>
  getStats: (query?: UsageStatsQuery) => Promise<UsageStatsSnapshot>
  syncSessions: () => Promise<StatusSnapshot>
  getDeviceProvisioning: () => Promise<DeviceProvisioningSnapshot>
  startDeviceScan: () => Promise<DeviceProvisioningSnapshot>
  stopDeviceScan: () => Promise<DeviceProvisioningSnapshot>
  provisionDevice: (request: DeviceProvisioningRequest) => Promise<DeviceProvisioningSnapshot>
  cancelDeviceProvisioning: () => Promise<DeviceProvisioningSnapshot>
  onStatus: (cb: (snapshot: StatusSnapshot) => void) => Unsubscribe
  onAgents: (cb: (agents: Agent[]) => void) => Unsubscribe
  onMute: (cb: (muted: boolean) => void) => Unsubscribe
  onUpdateAvailable: (cb: (update: UpdateInfo) => void) => Unsubscribe
  onUpdateProgress: (cb: (progress: UpdateDownloadProgress) => void) => Unsubscribe
  onDeviceProvisioning: (cb: (snapshot: DeviceProvisioningSnapshot) => void) => Unsubscribe
}

declare global {
  interface Window {
    codepulse: CodePulseApi
  }
}

export {}

/// <reference types="vite/client" />
import type {
  ProductView, DesktopForm, ShellSnapshot, WorkbenchWindowState,
  AmbientConfig,
  AmbientCard,
  AmbientSnapshot,
  DeviceStatusV1,
  Agent,
  AgentType,
  DeviceDisplayConfig,
  DeviceDisplaySnapshot,
  DeviceProvisioningRequest,
  DeviceProvisioningSnapshot,
  StatusSnapshot,
  UiLocale,
  UpdateDownloadProgress,
  UpdateInfo,
  UpdateInstallResult,
} from '@codepulse/shared'

type Unsubscribe = () => void
/** Theme values accepted by the native window chrome bridge. */
type WindowTheme = 'light' | 'dark'

/** 镜像 src/preload/index.ts 通过 contextBridge 暴露的 API。 */
export interface CodePulseApi {
  getShell: () => Promise<ShellSnapshot>
  navigateProduct: (view: ProductView) => Promise<ShellSnapshot>
  selectDesktopForm: (form: DesktopForm) => Promise<ShellSnapshot>
  openSurface: (surface: 'standard' | 'hud' | 'screen', view?: ProductView) => Promise<ShellSnapshot>
  onShell: (cb: (snapshot: ShellSnapshot) => void) => Unsubscribe
  setWorkbenchWindow: (patch: Partial<WorkbenchWindowState>) => Promise<WorkbenchWindowState>
  onWorkbenchWindow: (cb: (state: WorkbenchWindowState) => void) => Unsubscribe
  onDeviceDisplay: (cb: (snapshot: DeviceDisplaySnapshot) => void) => Unsubscribe
  importAmbientImage: (bytes: Uint8Array, name: string) => Promise<AmbientCard>
  addAmbientNote: (text: string) => Promise<AmbientCard>
  removeAmbient: (id: string) => Promise<AmbientSnapshot>
  getAmbient: () => Promise<AmbientSnapshot>
  setAmbient: (config: AmbientConfig) => Promise<AmbientSnapshot>
  setAmbientKey: (provider: AmbientConfig['provider'], key: string) => Promise<AmbientSnapshot>
  refreshAmbient: () => Promise<AmbientSnapshot>
  showAmbient: (id: string) => Promise<AmbientSnapshot>
  dismissAmbient: () => Promise<AmbientSnapshot>
  previewAmbient: (id: string) => Promise<DeviceStatusV1>
  openAmbient: (id: string) => Promise<void>
  onAmbient: (cb: (snapshot: AmbientSnapshot) => void) => Unsubscribe
  /** Host platform exposed by the constrained preload bridge. */
  platform: NodeJS.Platform
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType, workspacePath?: string, externalSessionId?: string) => Promise<boolean>
  /** Temporarily hides one HUD card without changing its task lifecycle. */
  dismissProjectCard: (
    agent: AgentType,
    workspacePath?: string,
    externalSessionId?: string,
  ) => Promise<boolean>
  setMute: (muted: boolean) => Promise<boolean>
  setLocale: (locale: UiLocale) => Promise<UiLocale>
  /** Synchronizes native title-bar colors with the resolved renderer theme. */
  setWindowTheme: (theme: WindowTheme) => Promise<WindowTheme>
  setHudContentHeight: (height: number) => Promise<boolean>
  /** Pushes the inactive-project retention preference to the main-process hub. */
  setResultRetentionMinutes: (minutes: number) => Promise<boolean>
  openSettingsWindow: () => Promise<boolean>
  detectAgents: () => Promise<Agent[]>
  getUpdate: () => Promise<UpdateInfo | null>
  dismissUpdate: () => Promise<boolean>
  installUpdate: () => Promise<UpdateInstallResult>
  syncSessions: () => Promise<StatusSnapshot>
  getDeviceDisplay: (preview?: DeviceDisplayConfig) => Promise<DeviceDisplaySnapshot>
  setDeviceDisplay: (config: DeviceDisplayConfig) => Promise<DeviceDisplaySnapshot>
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

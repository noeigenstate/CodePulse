/// <reference types="vite/client" />
import type {
  ProductView, DesktopForm, ShellSnapshot, WorkbenchWindowState, PresentationTarget, DesktopLayout,
  InkDisplayPlan, HudAppearanceSettings,
  AmbientConfig,
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
  StatsRangePreset,
  StatsTrendGranularity,
  UsageLedgerSnapshot,
} from '@codepulse/shared'

type Unsubscribe = () => void
/** Theme values accepted by the native window chrome bridge. */
type WindowTheme = 'light' | 'dark'

/** 镜像 src/preload/index.ts 通过 contextBridge 暴露的 API。 */
export interface CodePulseApi {
  openSettingsWindow: () => Promise<boolean>
  getShell: () => Promise<ShellSnapshot>
  setPresentationTarget: (target: PresentationTarget) => Promise<ShellSnapshot>
  setFocusMode: (focus: boolean) => Promise<ShellSnapshot>
  setDesktopLayout: (layout: DesktopLayout) => Promise<ShellSnapshot>
  setInkPlan: (plan: InkDisplayPlan) => Promise<ShellSnapshot>
  setHudSettings: (patch: Partial<HudAppearanceSettings>) => Promise<ShellSnapshot>
  setHudVisible: (visible: boolean) => Promise<ShellSnapshot>
  getHudPreview: () => Promise<StatusSnapshot | null>
  setHudContentHeight: (height: number) => Promise<boolean>
  navigateProduct: (view: ProductView) => Promise<ShellSnapshot>
  selectDesktopForm: (form: DesktopForm) => Promise<ShellSnapshot>
  openSurface: (surface: 'standard' | 'hud' | 'screen', view?: ProductView) => Promise<ShellSnapshot>
  onShell: (cb: (snapshot: ShellSnapshot) => void) => Unsubscribe
  setWorkbenchWindow: (patch: Partial<WorkbenchWindowState>) => Promise<WorkbenchWindowState>
  onWorkbenchWindow: (cb: (state: WorkbenchWindowState) => void) => Unsubscribe
  onDeviceDisplay: (cb: (snapshot: DeviceDisplaySnapshot) => void) => Unsubscribe
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
  ack: (agent: AgentType, workspacePath?: string) => Promise<boolean>
  getNotifications: () => Promise<boolean>
  setNotifications: (enabled: boolean) => Promise<boolean>
  setLocale: (locale: UiLocale) => Promise<UiLocale>
  /** Synchronizes native title-bar colors with the resolved renderer theme. */
  setWindowTheme: (theme: WindowTheme) => Promise<WindowTheme>
  detectAgents: () => Promise<Agent[]>
  getUpdate: () => Promise<UpdateInfo | null>
  /** Current app version from the main process (package metadata). */
  getVersion: () => Promise<string>
  /** Manual update check initiated from Settings. Resolves null when up to date. */
  checkUpdate: () => Promise<UpdateInfo | null>
  dismissUpdate: () => Promise<boolean>
  installUpdate: () => Promise<UpdateInstallResult>
  getUsage: (query?: {
    range?: StatsRangePreset
    granularity?: StatsTrendGranularity
  }) => Promise<UsageLedgerSnapshot | null>
  syncSessions: () => Promise<StatusSnapshot>
  /** Whether the MiMo console login (for OpenCode Token Plan quota) is present. */
  getMimoLogin: () => Promise<boolean>
  /** Opens the Xiaomi login window; resolves with the resulting login state. */
  loginMimo: () => Promise<boolean>
  /** Clears the MiMo console login. */
  logoutMimo: () => Promise<boolean>
  getDeviceDisplay: (preview?: DeviceDisplayConfig) => Promise<DeviceDisplaySnapshot>
  setDeviceDisplay: (config: DeviceDisplayConfig) => Promise<DeviceDisplaySnapshot>
  getDeviceProvisioning: () => Promise<DeviceProvisioningSnapshot>
  startDeviceScan: () => Promise<DeviceProvisioningSnapshot>
  stopDeviceScan: () => Promise<DeviceProvisioningSnapshot>
  provisionDevice: (request: DeviceProvisioningRequest) => Promise<DeviceProvisioningSnapshot>
  cancelDeviceProvisioning: () => Promise<DeviceProvisioningSnapshot>
  onStatus: (cb: (snapshot: StatusSnapshot) => void) => Unsubscribe
  onAgents: (cb: (agents: Agent[]) => void) => Unsubscribe
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

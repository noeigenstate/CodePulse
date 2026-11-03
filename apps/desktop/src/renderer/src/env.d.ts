/// <reference types="vite/client" />
import type { InkApplyRequest, InkScreenStatus, YuanbaoKeyInput, YuanbaoTestResult, YuanbaoTopic } from '@codepulse/shared'
import type { AssistantAudio, AssistantDraft, AssistantSecret, AssistantSettings, AssistantSnapshot, DeskTaskInput } from '@codepulse/shared'
import type {
  ProductView, DesktopForm, ShellSnapshot, WorkbenchWindowState, PresentationTarget, DesktopLayout,
  InkDisplayPlan, HudAppearanceSettings,
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
  WorkVoiceSettings, WorkVoiceTargetsSnapshot, WorkVoiceTarget,
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
  getAssistant: () => Promise<AssistantSnapshot>
  previewDeskTasks: () => Promise<DeviceStatusV1>
  configureAssistant: (settings: AssistantSettings) => Promise<AssistantSnapshot>
  setAssistantKey: (field: AssistantSecret, value: string) => Promise<AssistantSnapshot>
  addDeskTask: (input: DeskTaskInput) => Promise<AssistantSnapshot>
  updateDeskTask: (id: string, input: DeskTaskInput) => Promise<AssistantSnapshot>
  completeDeskTask: (id: string) => Promise<AssistantSnapshot>
  cancelDeskTask: (id: string) => Promise<AssistantSnapshot>
  snoozeDeskTask: (id: string, seconds: number) => Promise<AssistantSnapshot>
  forgetDeskMemory: (id: string) => Promise<AssistantSnapshot>
  interpretAssistant: (text: string) => Promise<AssistantDraft>
  applyAssistantDraft: (id: string) => Promise<AssistantSnapshot>
  listenAssistant: (pcm: Uint8Array) => Promise<{text:string;draft:AssistantDraft}>
  speakAssistant: (text: string) => Promise<AssistantAudio>
  showDeskTasksOnInk: () => Promise<AssistantSnapshot>
  hideDeskTasksOnInk: () => Promise<AssistantSnapshot>
  onAssistant: (cb: (snapshot: AssistantSnapshot) => void) => Unsubscribe
  openSettingsWindow: () => Promise<boolean>
  getShell: () => Promise<ShellSnapshot>
  setPresentationTarget: (target: PresentationTarget) => Promise<ShellSnapshot>
  setFocusMode: (focus: boolean) => Promise<ShellSnapshot>
  setDesktopLayout: (layout: DesktopLayout) => Promise<ShellSnapshot>
  setInkPlan: (plan: InkDisplayPlan) => Promise<ShellSnapshot>
  setHudSettings: (patch: Partial<HudAppearanceSettings>) => Promise<ShellSnapshot>
  setHudVisible: (visible: boolean) => Promise<ShellSnapshot>
  /** Single source for what the e-ink screen shows now; see InkScreenStatus. */
  getInkStatus: () => Promise<InkScreenStatus>
  onInkStatus: (cb: (status: InkScreenStatus) => void) => () => void
  /** Applies the playlist and the work-screen details together; rejects without partial writes. */
  applyInk: (request: InkApplyRequest) => Promise<{ shell: ShellSnapshot; display: DeviceDisplaySnapshot }>
  /** Ends any one-off display (desk card or todo list) without changing the playlist. */
  endInkTemporary: () => Promise<InkScreenStatus>
  getHudPreview: () => Promise<StatusSnapshot | null>
  setHudContentHeight: (height: number) => Promise<boolean>
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
  /** Saves 元宝搜索 credentials in the OS-encrypted key store; empty strings clear them. Never returns a key. */
  setYuanbaoKey: (input: YuanbaoKeyInput) => Promise<AmbientSnapshot>
  /** One live weather request (counted against the daily limit) to check the key and connectivity. */
  testYuanbao: () => Promise<YuanbaoTestResult>
  previewYuanbaoSample: (topic: YuanbaoTopic) => Promise<DeviceStatusV1>
  previewAmbient: (id: string) => Promise<DeviceStatusV1>
  openAmbient: (id: string) => Promise<void>
  onAmbient: (cb: (snapshot: AmbientSnapshot) => void) => Unsubscribe
  /** Host platform exposed by the constrained preload bridge. */
  platform: NodeJS.Platform
  getStatus: () => Promise<StatusSnapshot>
  ack: (agent: AgentType, workspacePath?: string) => Promise<boolean>
  getWorkVoice: () => Promise<WorkVoiceTargetsSnapshot>
  setWorkVoice: (target: WorkVoiceTarget, settings: WorkVoiceSettings) => Promise<WorkVoiceTargetsSnapshot>
  testWorkVoice: (target: WorkVoiceTarget, locale: UiLocale) => Promise<WorkVoiceTargetsSnapshot>
  stopWorkVoice: (target: WorkVoiceTarget) => Promise<WorkVoiceTargetsSnapshot>
  onWorkVoice: (cb: (snapshot: WorkVoiceTargetsSnapshot) => void) => () => void
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

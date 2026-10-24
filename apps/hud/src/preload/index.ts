import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  ProductView, DesktopForm, ShellSnapshot, WorkbenchWindowState,
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
  getShell: (): Promise<ShellSnapshot> => ipcRenderer.invoke('codepulse:shell-get'),
  navigateProduct: (view: ProductView): Promise<ShellSnapshot> => ipcRenderer.invoke('codepulse:shell-navigate', view),
  selectDesktopForm: (form: DesktopForm): Promise<ShellSnapshot> => ipcRenderer.invoke('codepulse:shell-form', form),
  openSurface: (surface: 'standard' | 'hud' | 'screen', view?: ProductView): Promise<ShellSnapshot> => ipcRenderer.invoke('codepulse:shell-open', surface, view),
  onShell: (cb: (snapshot: ShellSnapshot) => void): Unsubscribe => subscribe('codepulse:shell-status', cb),
  setWorkbenchWindow: (patch: Partial<WorkbenchWindowState>): Promise<WorkbenchWindowState> => ipcRenderer.invoke('codepulse:workbench-configure', patch),
  onWorkbenchWindow: (cb: (state: WorkbenchWindowState) => void): Unsubscribe => subscribe('codepulse:workbench-window', cb),
  onDeviceDisplay: (cb: (snapshot: DeviceDisplaySnapshot) => void): Unsubscribe => subscribe('codepulse:device-display', cb),
  getAmbient: (): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-get'),
  setAmbient: (config: AmbientConfig): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-set', config),
  setAmbientKey: (provider: AmbientConfig['provider'], key: string): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-key', provider, key),
  refreshAmbient: (): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-refresh'),
  showAmbient: (id: string): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-show', id),
  dismissAmbient: (): Promise<AmbientSnapshot> => ipcRenderer.invoke('codepulse:ambient-dismiss'),
  previewAmbient: (id: string): Promise<DeviceStatusV1> => ipcRenderer.invoke('codepulse:ambient-preview', id),
  openAmbient: (id: string): Promise<void> => ipcRenderer.invoke('codepulse:ambient-open', id),
  onAmbient: (cb: (snapshot: AmbientSnapshot) => void): Unsubscribe => subscribe('codepulse:ambient-status', cb),
  /** Lets the renderer opt into Windows-only title-bar layout without Node access. */
  platform: process.platform,
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:get-status'),
  ack: (agent: AgentType, workspacePath?: string, externalSessionId?: string): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:ack', agent, workspacePath, externalSessionId),
  /** Temporarily hides one HUD project card until new real activity arrives. */
  dismissProjectCard: (
    agent: AgentType,
    workspacePath?: string,
    externalSessionId?: string,
  ): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:dismiss-project-card', agent, workspacePath, externalSessionId),
  setMute: (muted: boolean): Promise<boolean> => ipcRenderer.invoke('codepulse:set-mute', muted),
  setLocale: (locale: UiLocale): Promise<UiLocale> =>
    ipcRenderer.invoke('codepulse:set-locale', locale),
  /** Keeps native window controls aligned with the renderer's selected palette. */
  setWindowTheme: (theme: WindowTheme): Promise<WindowTheme> =>
    ipcRenderer.invoke('codepulse:set-window-theme', theme),
  /** Reports the project stack's natural height so the transparent HUD can fit it. */
  setHudContentHeight: (height: number): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:set-hud-content-height', height),
  /** Sends the inactive-project retention preference to the main-process hub. */
  setResultRetentionMinutes: (minutes: number): Promise<boolean> =>
    ipcRenderer.invoke('codepulse:set-result-retention', minutes),
  /** Opens a normal, non-HUD settings BrowserWindow. */
  openSettingsWindow: (): Promise<boolean> => ipcRenderer.invoke('codepulse:open-settings-window'),
  detectAgents: (): Promise<Agent[]> => ipcRenderer.invoke('codepulse:detect-agents'),
  getUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke('codepulse:get-update'),
  /** User dismissed the update modal — main process snoozes checks for 24h. */
  dismissUpdate: (): Promise<boolean> => ipcRenderer.invoke('codepulse:dismiss-update'),
  installUpdate: (): Promise<UpdateInstallResult> => ipcRenderer.invoke('codepulse:install-update'),
  /** 主动扫本机 Codex/Grok 会话目录，返回最新 StatusHub 快照。 */
  syncSessions: (): Promise<StatusSnapshot> => ipcRenderer.invoke('codepulse:sync-sessions'),
  getDeviceDisplay: (preview?: DeviceDisplayConfig): Promise<DeviceDisplaySnapshot> =>
    ipcRenderer.invoke('codepulse:get-device-display', preview),
  setDeviceDisplay: (config: DeviceDisplayConfig): Promise<DeviceDisplaySnapshot> =>
    ipcRenderer.invoke('codepulse:set-device-display', config),
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

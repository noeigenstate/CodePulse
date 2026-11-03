/** Shared work speech policy, independently enabled for desktop and e-paper outputs. */
export interface WorkVoiceSettings {
  enabled: boolean
  intervention: boolean
  failures: boolean
}

export interface WorkVoiceSnapshot {
  settings: WorkVoiceSettings
  supported: boolean
  speaking: boolean
  error: 'unavailable' | 'failed' | null
}

export const DEFAULT_WORK_VOICE: WorkVoiceSettings = {
  enabled: false,
  intervention: true,
  failures: true,
}

export type WorkVoiceTarget = 'desktop' | 'ink'
export interface WorkVoicePreferences {
  version: 2
  desktop: WorkVoiceSettings
  ink: WorkVoiceSettings
}
export interface WorkVoiceTargetsSnapshot {
  version: 2
  desktop: WorkVoiceSnapshot
  ink: WorkVoiceSnapshot & { deviceAvailable: boolean }
}

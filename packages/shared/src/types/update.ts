export interface UpdateInfo {
  currentVersion: string
  version: string
  tag: string
  releaseUrl: string
  installable: boolean
  installerName?: string
  installerUrl?: string
  /** Bullet lines from the GitHub Release body (user-facing changelog). */
  releaseNotes?: string[]
}

/** Stages of the in-app update flow shown on the progress UI. */
export type UpdateProgressPhase = 'preparing' | 'downloading' | 'verifying' | 'launching'

export interface UpdateDownloadProgress {
  /** Current stage of download → verify → launch installer. */
  phase: UpdateProgressPhase
  received: number
  total?: number
  /** Download percent 0–100 when known (primarily for the downloading phase). */
  percent?: number
}

export type UpdateInstallResult = { ok: true } | { ok: false; error: string }

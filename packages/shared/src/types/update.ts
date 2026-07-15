export interface UpdateInfo {
  currentVersion: string
  version: string
  tag: string
  releaseUrl: string
  installable: boolean
  installerName?: string
  installerUrl?: string
  /**
   * Lowercase hex SHA-256 of the installer when known (from GitHub asset digest
   * or a sibling `.sha256` asset). Used to verify downloads before launch.
   */
  installerSha256?: string
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

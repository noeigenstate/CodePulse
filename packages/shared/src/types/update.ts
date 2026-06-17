export interface UpdateInfo {
  currentVersion: string
  version: string
  tag: string
  releaseUrl: string
  installerName: string
  installerUrl: string
}

export type UpdateInstallResult = { ok: true } | { ok: false; error: string }

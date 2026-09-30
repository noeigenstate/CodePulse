import { readFileSync, writeFileSync } from 'node:fs'

/**
 * Reads the persisted desktop-notification opt-in.
 *
 * Notifications are off by default: a missing, unreadable, or malformed file,
 * or any value other than `enabled: true`, keeps them disabled.
 *
 * @param path JSON settings file under Electron's userData directory.
 * @returns Whether desktop notifications should be shown.
 */
export function readNotificationsEnabled(path: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { enabled?: unknown } | null
    return raw?.enabled === true
  } catch {
    return false
  }
}

/**
 * Persists the desktop-notification opt-in.
 *
 * @param path JSON settings file under Electron's userData directory.
 * @param value Untrusted value received over IPC; only `true` enables notifications.
 * @returns The normalized value now in effect, even if writing the file failed.
 */
export function writeNotificationsEnabled(path: string, value: unknown): boolean {
  const enabled = value === true
  try {
    writeFileSync(path, `${JSON.stringify({ enabled, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.error('[codepulse] failed to write notification settings', err)
  }
  return enabled
}

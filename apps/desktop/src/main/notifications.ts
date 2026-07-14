import { join } from 'node:path'
import { app, Notification, type NotificationConstructorOptions } from 'electron'
import type { NotificationRequest } from '@codepulse/shared'

export function showNotification(request: NotificationRequest, onClick: () => void): void {
  if (!Notification.isSupported()) return

  const body = compactNotificationBody(request.body)
  const options: NotificationConstructorOptions = {
    title: compactText(request.title, 56),
    icon: notificationIconPath(),
    silent: !request.sound,
    urgency: request.level === 'strong' ? 'critical' : 'normal',
  }
  if (body) options.body = body

  const notification = new Notification(options)
  notification.on('click', onClick)
  notification.show()
}

function notificationIconPath(): string {
  return join(app.getAppPath(), 'build/icon.png')
}

/**
 * Toast body is already a short word-capped summary from the rule engine.
 * Avoid re-truncating mid-phrase; only guard extreme OS limits.
 */
function compactNotificationBody(body: string): string {
  const normalized = body.replace(/\s+/g, ' ').trim()
  if (!normalized) return ''
  // Windows toast body comfortably shows ~2 short lines; keep the full summary.
  return compactText(normalized, 96)
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  // Prefer cutting on a word boundary when possible.
  const slice = normalized.slice(0, maxLength - 1)
  const boundary = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('，'), slice.lastIndexOf(','))
  const cut = boundary >= Math.floor(maxLength * 0.5) ? slice.slice(0, boundary) : slice
  return `${cut.trimEnd()}…`
}

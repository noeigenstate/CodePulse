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

function compactNotificationBody(body: string): string {
  const firstSentence = body.split(/[。?!?；;]/)[0]?.trim()
  // Allow short cute completion lines with emoji without over-truncating.
  return compactText(firstSentence || body, 40)
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

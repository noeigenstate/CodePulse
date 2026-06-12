/**
 * 桌面通知展示层。把规则引擎的 {@link NotificationRequest}
 * 映射为操作系统通知。
 *
 * @module main/notifications
 */
import { join } from 'node:path'
import { app, Notification } from 'electron'
import type { NotificationRequest } from '@codepulse/shared'

const APP_NAME = 'CodePulse'

/**
 * 为规则引擎请求显示一条桌面通知。
 *
 * 节流、去重与声音决策已由规则引擎完成，本层只负责把
 * `level` 映射为展示形式并接线点击处理器。
 * 在不支持通知的平台上为空操作。
 *
 * @param request 要显示的通知。
 * @param onClick 用户点击通知时调用（例如聚焦窗口）。
 */
export function showNotification(request: NotificationRequest, onClick: () => void): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: `${APP_NAME} - ${compactText(request.title, 28)}`,
    body: compactNotificationBody(request.body),
    icon: notificationIconPath(),
    silent: !request.sound,
    urgency: request.level === 'strong' ? 'critical' : 'normal',
  })

  notification.on('click', onClick)
  notification.show()
}

function notificationIconPath(): string {
  return join(app.getAppPath(), 'build/icon.png')
}

function compactNotificationBody(body: string): string {
  const firstSentence = body.split(/[。.!?；;]/)[0]?.trim()
  return compactText(firstSentence || body, 72)
}

function compactText(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 1)}…`
}

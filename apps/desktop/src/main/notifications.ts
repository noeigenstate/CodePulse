/**
 * Desktop notification presentation. Maps a rule-engine
 * {@link NotificationRequest} onto an OS notification.
 *
 * @module main/notifications
 */
import { Notification } from 'electron'
import type { NotificationRequest } from '@codepulse/shared'

/**
 * Shows a desktop notification for a rule-engine request.
 *
 * Throttling, dedup, and the sound decision have already been made by the rule
 * engine, so this layer only maps `level` → presentation and wires the click
 * handler. No-op on platforms where notifications are unsupported.
 *
 * @param request The notification to display.
 * @param onClick Invoked when the user clicks the notification (e.g. to focus
 *   the window).
 */
export function showNotification(request: NotificationRequest, onClick: () => void): void {
  if (!Notification.isSupported()) return

  const notification = new Notification({
    title: request.title,
    body: request.body,
    silent: !request.sound,
    urgency: request.level === 'strong' ? 'critical' : 'normal',
  })

  notification.on('click', onClick)
  notification.show()
}

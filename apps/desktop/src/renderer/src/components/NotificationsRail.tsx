/**
 * The right-hand notifications rail: a scrollable list of recent notifications,
 * colour-coded by severity, each dismissible.
 *
 * @module renderer/components/NotificationsRail
 */
import type { NotificationRequest } from '@codepulse/shared'
import { formatRelative } from '../lib/format.js'

/**
 * Props for {@link NotificationsRail}.
 */
interface Props {
  /** Recent notifications, newest first. */
  notifications: NotificationRequest[]
  /** Current time in epoch millis, for relative timestamps. */
  now: number
  /** Invoked to dismiss a notification by its dedupe key. */
  onDismiss: (dedupeKey: string) => void
}

/** Left-border colour per notification level. */
const LEVEL_STYLE: Record<NotificationRequest['level'], string> = {
  soft: 'border-l-gray-500',
  normal: 'border-l-green-400',
  strong: 'border-l-yellow-400',
}

/**
 * Renders the notifications rail (hidden below the `lg` breakpoint).
 *
 * @param props See {@link Props}.
 * @returns The rail element.
 */
export function NotificationsRail({ notifications, now, onDismiss }: Props): JSX.Element {
  return (
    <aside className="hidden w-80 shrink-0 border-l border-ink-700 p-4 lg:block">
      <h3 className="mb-3 text-sm font-semibold text-gray-300">提醒</h3>
      {notifications.length === 0 ? (
        <p className="text-sm text-gray-500">暂无提醒</p>
      ) : (
        <ul className="space-y-2">
          {notifications.map((note) => (
            <li
              key={`${note.dedupeKey}-${note.createdAt}`}
              className={`rounded-md border-l-2 bg-ink-800/70 p-3 ${LEVEL_STYLE[note.level]}`}
            >
              <div className="flex items-start justify-between gap-2">
                <span className="text-sm font-medium text-gray-200">{note.title}</span>
                <button
                  onClick={() => onDismiss(note.dedupeKey)}
                  className="text-xs text-gray-500 hover:text-gray-300"
                  aria-label="dismiss"
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-gray-400">{note.body}</p>
              <p className="mt-1 text-[10px] text-gray-600">{formatRelative(note.createdAt, now)}</p>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}

/**
 * The Dashboard header: product title, the aggregated overall-state indicator,
 * and the "clear alerts" / mute controls.
 *
 * @module renderer/components/Header
 */
import type { OverallState } from '@codepulse/shared'
import { overallStyle } from '../lib/format.js'

/**
 * Props for {@link Header}.
 */
interface Props {
  /** The aggregated overall state to indicate. */
  overall: OverallState
  /** Whether notification sound is currently muted. */
  muted: boolean
  /** Toggles mute. */
  onToggleMute: () => void
  /** Acknowledges all unread alerts. */
  onClearAlerts: () => void
}

/**
 * Renders the top header bar.
 *
 * @param props See {@link Props}.
 * @returns The header element.
 */
export function Header({ overall, muted, onToggleMute, onClearAlerts }: Props): JSX.Element {
  const style = overallStyle(overall)
  return (
    <header className="flex items-center justify-between border-b border-ink-700 px-6 py-4">
      <div className="flex items-center gap-3">
        <span className="text-xl font-bold tracking-tight text-gray-100">CodePulse</span>
        <span className="rounded-full bg-ink-700 px-1.5 py-0.5 text-[10px] text-gray-400">
          码脉桌面端
        </span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${style.dot}`} />
          <span className={style.text}>{style.label}</span>
        </div>
        <button
          onClick={onClearAlerts}
          className="rounded-md border border-ink-600 px-3 py-1.5 text-xs text-gray-300 transition hover:bg-ink-700"
        >
          清除提醒
        </button>
        <button
          onClick={onToggleMute}
          className={`rounded-md px-3 py-1.5 text-xs transition ${
            muted
              ? 'bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30'
              : 'border border-ink-600 text-gray-300 hover:bg-ink-700'
          }`}
        >
          {muted ? '已静音' : '静音 30 分钟'}
        </button>
      </div>
    </header>
  )
}

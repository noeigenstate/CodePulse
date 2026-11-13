import type { InkNavText } from '../lib/inkStatusText.js'

/** The state mark over the device icon's corner; the row's accessible name carries the words. */
export function InkNavStatus({ text }: { text: InkNavText }): JSX.Element {
  return (
    <span
      className={`product-nav-status is-${text.dot}`}
      data-state={text.state}
      aria-hidden="true"
    />
  )
}

/**
 * Announces connection changes without the per-minute countdown that the row's name also holds:
 * only the one-word connection state sits in this live region.
 */
export function InkNavAnnouncer({ word }: { word?: string }): JSX.Element {
  return (
    <span role="status" className="page-sr">
      {word}
    </span>
  )
}

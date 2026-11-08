import type { InkScreenStatus } from '@codepulse/shared'
import { useInkStatus } from '../lib/useInkStatus.js'
import { useNow } from '../lib/useNow.js'
import { inkPillText } from '../lib/inkStatusText.js'
import type { Locale } from '../lib/i18n.js'

/** Status stays readable in the rail; temporary-display actions belong to the device page. */
export function InkStatusDisplay({
  status,
  now,
  locale,
}: {
  status: InkScreenStatus
  now: number
  locale: Locale
}): JSX.Element {
  const pill = inkPillText(status, now, locale)
  const prefix =
    pill.prefix === '墨水屏'
      ? '墨水屏设备'
      : pill.prefix === 'E-paper'
        ? 'E-paper Device'
        : pill.prefix
  return (
    <div className="ink-pill-wrap">
      <div
        className="ink-pill"
        data-state={pill.state}
        role="status"
        aria-label={pill.title.replace(pill.prefix, prefix)}
      >
        <span className={`ink-pill-dot is-${pill.dot}`} aria-hidden="true" />
        <span className="ink-pill-text">
          <b>{prefix}</b> {pill.label}
        </span>
      </div>
    </div>
  )
}

export function InkStatusPill({ locale }: { locale: Locale }): JSX.Element | null {
  const status = useInkStatus()
  const now = useNow(15000)
  return status ? <InkStatusDisplay status={status} now={now} locale={locale} /> : null
}

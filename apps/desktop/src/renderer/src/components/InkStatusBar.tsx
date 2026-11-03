import { useEffect, useRef, useState } from 'react'
import { useInkStatus } from '../lib/useInkStatus.js'
import { useNow } from '../lib/useNow.js'
import { inkPillText } from '../lib/inkStatusText.js'
import type { Locale } from '../lib/i18n.js'

/**
 * The one e-ink status pill at the bottom of the sidebar (not shown in focus mode). Clicking it
 * opens 控制 › 墨水屏; the ✕ only ends a temporary display. When the rail narrows it collapses to
 * its dot, and the full text stays in the title and aria-label. Wording is {@link inkPillText}.
 */
export function InkStatusPill({
  locale,
  onOpen,
}: {
  locale: Locale
  onOpen: () => void
}): JSX.Element | null {
  const status = useInkStatus()
  const now = useNow(15000)
  const [failed, setFailed] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const zhText = locale === 'zh'
  const pill = status ? inkPillText(status, now, locale) : undefined
  const stateKey = pill?.state
  const previousState = useRef<string>()
  // A polite live region: only a change of state (connected, disconnected, temporary, service off) is announced, never the countdown.
  useEffect(() => {
    if (!pill || stateKey === previousState.current) return
    if (previousState.current !== undefined) setAnnouncement(`${pill.prefix} ${pill.label}`)
    previousState.current = stateKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateKey])
  if (!status || !pill) return null
  const zh = zhText
  const open = zh ? '打开 控制 › 墨水屏' : 'Open Control › E-paper'
  const back = zh ? '回到工作画面' : 'Back to work screen'
  const end = (): void => {
    setFailed(false)
    void window.codepulse.endInkTemporary().catch(() => setFailed(true))
  }
  return (
    <div className="ink-pill-wrap">
      <span className="page-sr" role="status" aria-live="polite">
        {announcement}
      </span>
      <div className="ink-pill" data-state={pill.state}>
        <button
          type="button"
          className="ink-pill-main"
          onClick={onOpen}
          title={pill.title}
          aria-label={`${pill.title}。${open}`}
        >
          <span className={`ink-pill-dot is-${pill.dot}`} aria-hidden="true" />
          <span className="ink-pill-text">
            <b>{pill.prefix}</b> {pill.label}
          </span>
          {pill.info && (
            <span className="ink-pill-info" title={pill.info} aria-hidden="true">
              ⓘ
            </span>
          )}
        </button>
        {pill.canEnd && (
          <button
            type="button"
            className="ink-pill-end"
            onClick={end}
            title={back}
            aria-label={back}
          >
            ✕
          </button>
        )}
      </div>
      {failed && (
        <p className="ink-pill-error" role="alert">
          {zh ? '未能回到工作画面，请重试。' : 'Could not return to the work screen.'}
        </p>
      )}
    </div>
  )
}

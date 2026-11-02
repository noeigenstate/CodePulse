import { useState } from 'react'
import { useInkStatus } from '../lib/useInkStatus.js'
import { useNow } from '../lib/useNow.js'
import { inkStatusText } from '../lib/inkStatusText.js'
import type { Locale } from '../lib/i18n.js'

/**
 * The one e-ink status line shown at the top of every product page (not in focus mode).
 * All wording comes from {@link inkStatusText}; the state itself comes from the main process.
 */
export function InkStatusBar({ locale, hideConnect, onConnect, onPlaylist }: {
  locale: Locale
  /** 控制 › 墨水屏 owns the connect button in its empty-state card. */
  hideConnect: boolean
  onConnect: () => void
  onPlaylist: () => void
}): JSX.Element | null {
  const status = useInkStatus()
  const now = useNow(15000)
  const [failed, setFailed] = useState(false)
  if (!status) return null
  const zh = locale === 'zh'
  const text = inkStatusText(status, now, locale)
  const run = (): void => {
    if (text.action === 'connect') onConnect()
    else if (text.action === 'playlist') onPlaylist()
    else if (text.action === 'end-temporary') {
      setFailed(false)
      void window.codepulse.endInkTemporary().catch(() => setFailed(true))
    }
  }
  const button = text.action && !(text.action === 'connect' && hideConnect)
  return (
    <section className="ink-status" data-state={text.state} aria-label={zh ? '墨水屏状态' : 'E-paper status'}>
      <div className="ink-status-row" role="status">
        <span className={`ink-status-dot is-${text.dot}`} aria-hidden="true" />
        <strong>{text.headline}</strong>
        <span className="ink-status-messages">
          {text.messages.map((message, index) => (
            <span key={message} className={text.emphasis && index === 0 ? 'is-strong' : undefined}>{message}</span>
          ))}
        </span>
        {button && text.action === 'playlist' && (
          <button type="button" className="ink-status-link" onClick={run}>{text.actionLabel}</button>
        )}
        {button && text.action !== 'playlist' && (
          <button type="button" className="product-button is-compact" onClick={run}>{text.actionLabel}</button>
        )}
      </div>
      {text.note && <p className="ink-status-note">{text.note}</p>}
      {failed && <p className="ink-status-note" role="alert">{zh ? '未能回到工作画面，请重试。' : 'Could not return to the work screen. Try again.'}</p>}
    </section>
  )
}

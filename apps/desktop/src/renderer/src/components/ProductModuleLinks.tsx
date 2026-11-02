import { useState } from 'react'
import type { Locale } from '../lib/i18n.js'

/** Settings shortcut to the desk-content page; the screen workbench has no entry here any more. */
export function ProductModuleLinks({ onOpen, embedded = false, locale = 'zh' }: {
  onOpen?: () => void
  embedded?: boolean
  locale?: Locale
}): JSX.Element {
  const zh = locale === 'zh'
  const [error, setError] = useState('')
  const open = () =>
    void window.codepulse
      .openSurface('standard', 'ambient')
      .then(() => onOpen?.())
      .catch(() => setError(zh ? '请重新启动统一桌面应用。' : 'Restart the unified desktop app.'))
  return (
    <section className={embedded ? 'page-card' : 'border-t border-line pt-5'}>
      <h2 className="text-sm font-semibold text-ink">{zh ? '内容与展示端' : 'Content and surfaces'}</h2>
      <p className="page-card-sub">
        {zh ? '在桌边内容中管理 X 与 meme，在控制中选择展示端。' : 'Manage X and memes in Desk content; choose surfaces in Control.'}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="product-button" onClick={open}>
          {zh ? '桌边内容（X 与 meme）' : 'Desk content (X and memes)'}
        </button>
      </div>
      {error && <p role="status" className="page-muted">{error}</p>}
    </section>
  )
}

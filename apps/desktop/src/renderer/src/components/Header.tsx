import { headerCopy, type Locale } from '../lib/i18n.js'
import codePulseIcon from '../assets/codepulse-icon.svg'

interface Props {
  locale: Locale
  onToggleLocale: () => void
  onOpenStats: () => void
  onOpenSettings: () => void
  /** Drives only the gear button's active visual state while the dialog is mounted. */
  settingsOpen?: boolean
}

/** Renders global dashboard controls, including the settings trigger beside insights. */
export function Header({
  locale,
  onToggleLocale,
  onOpenStats,
  onOpenSettings,
  settingsOpen = false,
}: Props): JSX.Element {
  const copy = headerCopy(locale)

  return (
    <header className="px-6 pb-3 pt-5">
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <img
            src={codePulseIcon}
            alt=""
            className="brand-mark h-11 w-11 shrink-0 rounded-full object-contain shadow-soft"
          />
          <div className="min-w-0">
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="truncate text-title tracking-tight text-ink">CodePulse</h1>
              {copy.brandTag ? (
                <span className="text-meta font-semibold text-brand-claude">{copy.brandTag}</span>
              ) : null}
            </div>
            <p className="mt-0.5 text-meta text-ink-500">{copy.subtitle}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={onToggleLocale}
            className="control-btn lang-switch"
            data-locale={locale}
            aria-label={copy.languageToggle}
            title={copy.languageToggle}
          >
            <span className="lang-switch-thumb" aria-hidden="true" />
            <span className={`lang-switch-option ${locale === 'zh' ? 'is-on' : ''}`}>中</span>
            <span className={`lang-switch-option ${locale === 'en' ? 'is-on' : ''}`}>EN</span>
          </button>
          <button type="button" onClick={onOpenStats} className="control-btn" title={copy.stats}>
            <ChartIcon />
            <span>{copy.stats}</span>
          </button>
          <button
            aria-label={copy.settings}
            className={`control-btn control-btn-icon ${settingsOpen ? 'is-active' : ''}`}
            onClick={onOpenSettings}
            title={copy.settings}
            type="button"
          >
            <SettingsIcon />
          </button>
        </div>
      </div>
    </header>
  )
}

function ChartIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 3.5v11.25c0 .97.78 1.75 1.75 1.75H16.5" />
      <path d="M7.5 13v-3M11 13V6.5M14.5 13V9" />
    </svg>
  )
}

function SettingsIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 20 20"
      className="h-[18px] w-[18px]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M3.5 6h6.25M13.75 6h2.75M3.5 14h2.75M10.25 14h6.25" />
      <circle cx="11.75" cy="6" r="2" />
      <circle cx="8.25" cy="14" r="2" />
    </svg>
  )
}

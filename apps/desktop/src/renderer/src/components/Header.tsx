import { headerCopy, type Locale } from '../lib/i18n.js'
import codePulseIcon from '../assets/codepulse-icon.png'

interface Props {
  locale: Locale
  muted: boolean
  onToggleLocale: () => void
  onToggleMute: () => void
  onOpenStats: () => void
}

export function Header({
  locale,
  muted,
  onToggleLocale,
  onToggleMute,
  onOpenStats,
}: Props): JSX.Element {
  const copy = headerCopy(locale)

  return (
    <header className="px-6 pb-3 pt-5">
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 items-center gap-3.5">
          <img
            src={codePulseIcon}
            alt=""
            className="app-logo h-11 w-11 shrink-0 rounded-full object-contain shadow-soft"
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
            className="control-btn"
            title={copy.languageToggle}
          >
            <GlobeIcon />
            <span>{copy.languageToggle}</span>
          </button>
          <button
            type="button"
            onClick={onToggleMute}
            className={`control-btn ${
              muted ? 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100' : ''
            }`}
            title={muted ? copy.muted : copy.mute}
          >
            {muted ? <BellOffIcon /> : <BellIcon />}
            <span>{muted ? copy.muted : copy.mute}</span>
          </button>
          <button type="button" onClick={onOpenStats} className="control-btn" title={copy.stats}>
            <ChartIcon />
            <span>{copy.stats}</span>
          </button>
        </div>
      </div>
    </header>
  )
}

function GlobeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 1.5a8.5 8.5 0 100 17 8.5 8.5 0 000-17zm0 1.5c1.5 0 2.9.5 4 1.3A14 14 0 0012.2 8H7.8A14 14 0 006 4.3 6.9 6.9 0 0110 3zm-5.3 2.1A12.5 12.5 0 016.3 9H3.6a7 7 0 011.1-3.9zM3.6 11h2.7a12.5 12.5 0 01-1.6 3.9A7 7 0 013.6 11zm3.1 0h4.6a14 14 0 01-1.8 4.2A6.9 6.9 0 0110 17a6.9 6.9 0 01-1.5-1.8A14 14 0 016.7 11zm6 0h2.7a7 7 0 01-1.1 3.9A12.5 12.5 0 0112.7 11zm2.7-2h-2.7A12.5 12.5 0 0114.3 5a7 7 0 011.1 4z"
      />
    </svg>
  )
}

function BellIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10 2a5 5 0 00-5 5v2.2c0 .5-.2 1-.5 1.4L3.3 12.5A1 1 0 004.1 14h11.8a1 1 0 00.8-1.5L15.5 10.6c-.3-.4-.5-.9-.5-1.4V7a5 5 0 00-5-5zm0 14a2 2 0 01-1.7-1h3.4A2 2 0 0110 16z"
      />
    </svg>
  )
}

function BellOffIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 opacity-80" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3.3 2.2a.75.75 0 00-1.1 1L4.5 5.5A5 5 0 005 7v2.2c0 .5-.2 1-.5 1.4L3.3 12.5A1 1 0 004.1 14h9.3l2.3 2.3a.75.75 0 001.1-1L3.3 2.2zM15 10.6l1.2 1.9H15.5L15 10.6zM10 2a5 5 0 014.7 3.3l-1.3 1.3A3.5 3.5 0 0010 3.5V2zm0 14a2 2 0 01-1.7-1h3.4A2 2 0 0110 16z"
      />
    </svg>
  )
}

function ChartIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true">
      <path
        fill="currentColor"
        d="M3 3a1 1 0 011-1h1a1 1 0 011 1v14H4a1 1 0 01-1-1V3zm5 6a1 1 0 011-1h1a1 1 0 011 1v8H8V9zm5-4a1 1 0 011-1h1a1 1 0 011 1v12h-3V5z"
      />
    </svg>
  )
}

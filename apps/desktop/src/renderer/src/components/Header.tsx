import { headerCopy, type Locale } from '../lib/i18n.js'
import codePulseIcon from '../assets/codepulse-icon.png'

interface Props {
  locale: Locale
  muted: boolean
  onToggleLocale: () => void
  onToggleMute: () => void
}

export function Header({ locale, muted, onToggleLocale, onToggleMute }: Props): JSX.Element {
  const copy = headerCopy(locale)

  return (
    <header className="px-5 py-3.5">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <img
            src={codePulseIcon}
            alt=""
            className="app-logo h-[3.25rem] w-[3.25rem] shrink-0 rounded-full object-contain"
          />
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-[1.65rem] font-semibold leading-none tracking-tight text-slate-950">
                CodePulse
              </span>
              {copy.brandTag && <span className="text-xs text-amber-700">{copy.brandTag}</span>}
            </div>
            <p className="mt-1 text-xs font-medium text-slate-500">{copy.subtitle}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <button
            onClick={onToggleLocale}
            className="control-glass h-11 min-w-11 rounded-xl px-3.5 text-sm font-semibold text-slate-800 transition hover:bg-white/75 active:translate-y-px"
          >
            {copy.languageToggle}
          </button>
          <button
            onClick={onToggleMute}
            className={`h-11 rounded-xl px-3.5 text-sm font-medium transition active:translate-y-px ${
              muted
                ? 'border border-amber-300/60 bg-amber-100/80 text-amber-800 hover:bg-amber-100'
                : 'control-glass text-slate-800 hover:bg-white/75'
            }`}
          >
            {muted ? copy.muted : copy.mute}
          </button>
        </div>
      </div>
    </header>
  )
}

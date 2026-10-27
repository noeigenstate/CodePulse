import { ProductModuleLinks } from './ProductModuleLinks.js'
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { Locale, SettingsCopy } from '../lib/i18n.js'
import { CLI_TOOL_TYPES, type CliToolType, type ThemePreference } from '../lib/dashboardSettings.js'

interface Props {
  embedded?: boolean
  copy: SettingsCopy
  locale?: Locale
  onLocaleChange?: (locale: Locale) => void
  onClose: () => void
  onThemeChange: (theme: ThemePreference) => void
  onToolVisibilityChange: (tool: CliToolType, visible: boolean) => void
  theme: ThemePreference
  visibleTools: Record<CliToolType, boolean>
}

/** Selector for interactive descendants that must remain inside the modal tab loop. */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Renders the dashboard appearance and visible-CLI preferences dialog.
 *
 * The parent owns persistence. While mounted, this dialog closes on Escape or
 * a backdrop click, traps keyboard focus, and restores the invoking control
 * after it closes.
 *
 * @param props Dialog copy, selected preferences, and update callbacks.
 * @returns The accessible modal settings dialog.
 */
export function SettingsDialog({
  embedded = false,
  copy,
  locale = 'zh',
  onLocaleChange,
  onClose,
  onThemeChange,
  onToolVisibilityChange,
  theme,
  visibleTools,
}: Props): JSX.Element {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [appVersion, setAppVersion] = useState<string>()
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateResult, setUpdateResult] = useState<
    { kind: 'none' } | { kind: 'found'; version: string } | { kind: 'error' } | undefined
  >()

  const [mimoLoggedIn, setMimoLoggedIn] = useState<boolean>()
  const [mimoBusy, setMimoBusy] = useState(false)
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>()

  useEffect(() => {
    void window.codepulse.getVersion().then(setAppVersion)
    void window.codepulse.getMimoLogin().then(setMimoLoggedIn)
    void window.codepulse.getNotifications().then(setNotificationsEnabled)
  }, [])

  /** Persists the desktop-notification opt-in in main, which gates every toast. */
  const changeNotifications = useCallback(async (enabled: boolean): Promise<void> => {
    setNotificationsEnabled(enabled)
    setNotificationsEnabled(await window.codepulse.setNotifications(enabled))
  }, [])

  /** Opens the Xiaomi login window, or clears the login when already signed in. */
  const toggleMimoLogin = useCallback(async (): Promise<void> => {
    setMimoBusy(true)
    try {
      setMimoLoggedIn(
        await (mimoLoggedIn ? window.codepulse.logoutMimo() : window.codepulse.loginMimo()),
      )
    } finally {
      setMimoBusy(false)
    }
  }, [mimoLoggedIn])

  /** Runs a manual update check; the update modal drives download/install afterwards. */
  const runUpdateCheck = useCallback(async (): Promise<void> => {
    setUpdateChecking(true)
    setUpdateResult(undefined)
    try {
      const update = await window.codepulse.checkUpdate()
      setUpdateResult(update ? { kind: 'found', version: update.version } : { kind: 'none' })
    } catch {
      setUpdateResult({ kind: 'error' })
    } finally {
      setUpdateChecking(false)
    }
  }, [])

  useEffect(() => {
    if (embedded) return
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = dialogRef.current
      if (!dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.tabIndex >= 0,
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }

      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      const active = document.activeElement
      const wrapTarget = event.shiftKey ? last : first
      if (event.shiftKey ? active === first : active === last) {
        event.preventDefault()
        wrapTarget.focus()
      } else if (!dialog.contains(active)) {
        event.preventDefault()
        wrapTarget.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [embedded])

  /** Close only when the user presses the inert backdrop itself. */
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div
      className={embedded ? 'product-settings-page' : 'settings-backdrop absolute inset-0 z-[60] flex items-center justify-center px-4'}
      onMouseDown={embedded ? undefined : closeOnBackdrop}
      role="presentation"
    >
      <section
        aria-label={copy.title}
        aria-modal={embedded ? undefined : true}
        className={embedded ? 'settings-dialog settings-embedded flex w-full flex-col' : 'settings-dialog flex max-h-[min(90vh,52rem)] w-full max-w-2xl flex-col'}
        ref={dialogRef}
        role={embedded ? undefined : 'dialog'}
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{copy.title}</h2>
          </div>
          <button
            hidden={embedded}
            aria-label={copy.close}
            className="settings-close"
            onClick={onClose}
            ref={closeButtonRef}
            title={copy.close}
            type="button"
          >
            <CloseIcon />
          </button>
        </div>

        <div className="grid min-h-0 gap-6 overflow-y-auto px-5 py-5">
          {onLocaleChange && (
            <section>
              <h3 className="text-sm font-semibold text-ink">
                {locale === 'zh' ? '界面语言' : 'Language'}
              </h3>
              <p className="mt-1.5 text-meta leading-5 text-ink-500">
                {locale === 'zh' ? '切换桌面端与控制面板显示语言。' : 'Switch the display language for desktop and controls.'}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button
                  aria-pressed={locale === 'zh'}
                  className={`theme-option !min-h-0 !flex-row !items-center !justify-center !py-2.5 ${locale === 'zh' ? 'is-active' : ''}`}
                  onClick={() => onLocaleChange('zh')}
                  type="button"
                >
                  <span>中文 (简体)</span>
                </button>
                <button
                  aria-pressed={locale === 'en'}
                  className={`theme-option !min-h-0 !flex-row !items-center !justify-center !py-2.5 ${locale === 'en' ? 'is-active' : ''}`}
                  onClick={() => onLocaleChange('en')}
                  type="button"
                >
                  <span>English</span>
                </button>
              </div>
            </section>
          )}
          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.theme}</h3>
            <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.themeAutoHint}</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <ThemeOption
                active={theme === 'auto'}
                label={copy.themeAuto}
                onClick={() => onThemeChange('auto')}
                theme="auto"
              />
              <ThemeOption
                active={theme === 'light'}
                label={copy.themeLight}
                onClick={() => onThemeChange('light')}
                theme="light"
              />
              <ThemeOption
                active={theme === 'dark'}
                label={copy.themeDark}
                onClick={() => onThemeChange('dark')}
                theme="dark"
              />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.notifications}</h3>
            <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.notificationsHint}</p>
            <div className="mt-3 grid gap-2">
              <ToolToggle
                checked={notificationsEnabled ?? false}
                disabled={notificationsEnabled === undefined}
                label={copy.notificationsToggle}
                onChange={(enabled) => void changeNotifications(enabled)}
              />
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.cliTools}</h3>
            <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.cliToolsHint}</p>
            <div className="mt-3 grid gap-2">
              {CLI_TOOL_TYPES.map((tool) => (
                <ToolToggle
                  checked={visibleTools[tool]}
                  key={tool}
                  label={toolLabel(tool, copy)}
                  onChange={(visible) => onToolVisibilityChange(tool, visible)}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.mimoQuota}</h3>
            <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.mimoQuotaHint}</p>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="min-w-0 truncate font-medium text-ink">
                {mimoLoggedIn === undefined
                  ? '—'
                  : mimoLoggedIn
                    ? copy.mimoLoggedIn
                    : copy.mimoLoggedOut}
              </p>
              <button
                className="product-button"
                disabled={mimoBusy || mimoLoggedIn === undefined}
                onClick={() => void toggleMimoLogin()}
                type="button"
              >
                {mimoBusy ? copy.mimoWorking : mimoLoggedIn ? copy.mimoLogout : copy.mimoLogin}
              </button>
            </div>
          </section>

          <ProductModuleLinks onOpen={embedded ? undefined : onClose} />

          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.updates}</h3>
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink">{copy.currentVersion}</p>
                <p className="mt-0.5 truncate text-meta text-ink-500">
                  {appVersion ? `v${appVersion}` : '—'}
                </p>
              </div>
              <button
                className="product-button"
                disabled={updateChecking}
                onClick={() => void runUpdateCheck()}
                type="button"
              >
                {updateChecking ? copy.checkingUpdate : copy.checkUpdate}
              </button>
            </div>
            {updateResult && (
              <p className="mt-1.5 text-meta leading-5 text-ink-500">
                {updateResult.kind === 'found'
                  ? copy.updateFound.replace('{version}', updateResult.version)
                  : updateResult.kind === 'error'
                    ? copy.updateError
                    : copy.updateNone}
              </p>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}

function ThemeOption({
  active,
  label,
  onClick,
  theme,
}: {
  active: boolean
  label: string
  onClick: () => void
  theme: ThemePreference
}): JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={`theme-option ${active ? 'is-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className={`theme-swatch theme-swatch-${theme}`} aria-hidden="true">
        {theme === 'light' ? <SunIcon /> : theme === 'dark' ? <MoonIcon /> : <AutoThemeIcon />}
      </span>
      <span>{label}</span>
    </button>
  )
}

function ToolToggle({
  checked,
  disabled = false,
  label,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-tool-row">
      <span className="font-medium text-ink">{label}</span>
      <input
        checked={checked}
        className="settings-switch"
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  )
}

function toolLabel(tool: CliToolType, copy: SettingsCopy): string {
  if (tool === 'codex') return copy.codex
  if (tool === 'claude_code') return copy.claudeCode
  if (tool === 'grok') return copy.grok
  if (tool === 'opencode') return copy.opencode
  return copy.kimi
}

function CloseIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20">
      <path
        d="M4 4l12 12M16 4L4 16"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.8"
      />
    </svg>
  )
}

function SunIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20">
      <circle cx="10" cy="10" fill="none" r="3.2" stroke="currentColor" strokeWidth="1.7" />
      <path
        d="M10 1.8v2M10 16.2v2M18.2 10h-2M3.8 10h-2M15.8 4.2l-1.4 1.4M5.6 14.4l-1.4 1.4M15.8 15.8l-1.4-1.4M5.6 5.6L4.2 4.2"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeWidth="1.6"
      />
    </svg>
  )
}

function MoonIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20">
      <path
        d="M16.5 12.2A6.8 6.8 0 017.8 3.5a6.8 6.8 0 108.7 8.7z"
        fill="none"
        stroke="currentColor"
        strokeLinejoin="round"
        strokeWidth="1.7"
      />
    </svg>
  )
}

/**
 * Renders the time-based automatic-theme icon.
 *
 * @returns The automatic-theme SVG icon.
 */
function AutoThemeIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20">
      <circle cx="10" cy="10" fill="none" r="6.8" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 5.7v4.5l3 1.8M5.4 4.7l1.2 1.1M14.6 4.7l-1.2 1.1"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      />
    </svg>
  )
}

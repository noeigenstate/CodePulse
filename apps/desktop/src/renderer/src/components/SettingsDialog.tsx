import { useEffect, useRef, type MouseEvent } from 'react'
import type { SettingsCopy } from '../lib/i18n.js'
import { CLI_TOOL_TYPES, type CliToolType, type ThemeMode } from '../lib/dashboardSettings.js'

interface Props {
  copy: SettingsCopy
  onClose: () => void
  onThemeChange: (theme: ThemeMode) => void
  onToolVisibilityChange: (tool: CliToolType, visible: boolean) => void
  theme: ThemeMode
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
  copy,
  onClose,
  onThemeChange,
  onToolVisibilityChange,
  theme,
  visibleTools,
}: Props): JSX.Element {
  const dialogRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    closeButtonRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
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
  }, [onClose])

  /** Close only when the user presses the inert backdrop itself. */
  const closeOnBackdrop = (event: MouseEvent<HTMLDivElement>): void => {
    if (event.target === event.currentTarget) onClose()
  }

  return (
    <div
      className="settings-backdrop fixed inset-0 z-[60] flex items-center justify-center px-4"
      onMouseDown={closeOnBackdrop}
      role="presentation"
    >
      <section
        aria-label={copy.title}
        aria-modal="true"
        className="settings-dialog w-full max-w-sm"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{copy.title}</h2>
          </div>
          <button
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

        <div className="grid gap-6 px-5 py-5">
          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.theme}</h3>
            <div className="mt-3 grid grid-cols-2 gap-2">
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
  theme: ThemeMode
}): JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={`theme-option ${active ? 'is-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className={`theme-swatch theme-swatch-${theme}`} aria-hidden="true">
        {theme === 'light' ? <SunIcon /> : <MoonIcon />}
      </span>
      <span>{label}</span>
    </button>
  )
}

function ToolToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="settings-tool-row">
      <span className="font-medium text-ink">{label}</span>
      <input
        checked={checked}
        className="settings-switch"
        onChange={(event) => onChange(event.target.checked)}
        type="checkbox"
      />
    </label>
  )
}

function toolLabel(tool: CliToolType, copy: SettingsCopy): string {
  if (tool === 'codex') return copy.codex
  if (tool === 'claude_code') return copy.claudeCode
  return copy.grok
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

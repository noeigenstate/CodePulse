import { useEffect, useRef, type MouseEvent } from 'react'
import type { SettingsCopy } from '../lib/i18n.js'
import {
  CLI_TOOL_TYPES,
  HUD_OPACITY_MAX,
  HUD_OPACITY_MIN,
  type CliToolType,
  type HudAttentionEffect,
  type HudProjectLayout,
  type ThemePreference,
} from '../lib/dashboardSettings.js'
import { DeviceProvisioningPanel } from './DeviceProvisioningPanel.js'

interface Props {
  standalone?: boolean
  copy: SettingsCopy
  attentionEffect: HudAttentionEffect
  hudOpacity: number
  projectLayout: HudProjectLayout
  resultRetentionMinutes: number
  showUsageStrip: boolean
  onAttentionEffectChange: (effect: HudAttentionEffect) => void
  onClose: () => void
  onHudOpacityChange: (opacity: number) => void
  onProjectLayoutChange: (layout: HudProjectLayout) => void
  onResultRetentionMinutesChange: (minutes: number) => void
  onShowUsageStripChange: (visible: boolean) => void
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
  standalone = false,
  copy,
  attentionEffect,
  hudOpacity,
  projectLayout,
  resultRetentionMinutes,
  showUsageStrip,
  onAttentionEffectChange,
  onClose,
  onHudOpacityChange,
  onProjectLayoutChange,
  onResultRetentionMinutesChange,
  onShowUsageStripChange,
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
    if (!standalone && event.target === event.currentTarget) onClose()
  }

  return (
    <div
      className={
        standalone
          ? 'settings-window-page flex h-full min-h-0'
          : 'settings-backdrop absolute inset-0 z-[60] flex items-center justify-center px-4'
      }
      onMouseDown={closeOnBackdrop}
      role="presentation"
    >
      <section
        aria-label={copy.title}
        aria-modal={standalone ? undefined : true}
        className={
          standalone
            ? 'settings-dialog settings-dialog-standalone flex h-full min-h-0 w-full flex-col'
            : 'settings-dialog flex max-h-[min(90vh,52rem)] w-full max-w-2xl flex-col'
        }
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-ink">{copy.title}</h2>
          </div>
          {!standalone ? (
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
          ) : null}
        </div>

        <div className="grid min-h-0 gap-6 overflow-y-auto px-5 py-5">
          <section>
            <h3 className="text-sm font-semibold text-ink">{copy.hudAppearance}</h3>
            <div className="hud-setting-card mt-3">
              <div className="flex items-center justify-between gap-4">
                <label className="text-sm font-medium text-ink" htmlFor="hud-opacity">
                  {copy.hudOpacity}
                </label>
                <output className="hud-opacity-value" htmlFor="hud-opacity">
                  {hudOpacity}%
                </output>
              </div>
              <input
                aria-describedby="hud-opacity-hint"
                className="hud-opacity-slider mt-3 w-full"
                id="hud-opacity"
                max={HUD_OPACITY_MAX}
                min={HUD_OPACITY_MIN}
                onChange={(event) => onHudOpacityChange(Number(event.target.value))}
                type="range"
                value={hudOpacity}
              />
              <p className="mt-2 text-meta leading-5 text-ink-500" id="hud-opacity-hint">
                {copy.hudOpacityHint}
              </p>
            </div>

            <div className="mt-4">
              <h4 className="text-sm font-medium text-ink">{copy.attentionEffect}</h4>
              <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.attentionEffectHint}</p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <HudEffectOption
                  active={attentionEffect === 'steady'}
                  label={copy.attentionSteady}
                  onClick={() => onAttentionEffectChange('steady')}
                />
                <HudEffectOption
                  active={attentionEffect === 'breathe'}
                  label={copy.attentionBreathe}
                  onClick={() => onAttentionEffectChange('breathe')}
                />
                <HudEffectOption
                  active={attentionEffect === 'pulse'}
                  label={copy.attentionPulse}
                  onClick={() => onAttentionEffectChange('pulse')}
                />
              </div>
            </div>

            <div className="mt-4">
              <h4 className="text-sm font-medium text-ink">{copy.resultRetention}</h4>
              <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.resultRetentionHint}</p>
              <div className="mt-3 grid grid-cols-5 gap-2">
                {copy.resultRetentionOptions.map((option) => (
                  <HudLayoutOption
                    active={resultRetentionMinutes === option.minutes}
                    key={option.minutes}
                    label={option.label}
                    onClick={() => onResultRetentionMinutesChange(option.minutes)}
                  />
                ))}
              </div>
            </div>

            <div className="mt-4">
              <h4 className="text-sm font-medium text-ink">{copy.projectLayout}</h4>
              <p className="mt-1.5 text-meta leading-5 text-ink-500">{copy.projectLayoutHint}</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <HudLayoutOption
                  active={projectLayout === 'grid'}
                  label={copy.projectLayoutGrid}
                  onClick={() => onProjectLayoutChange('grid')}
                />
                <HudLayoutOption
                  active={projectLayout === 'list'}
                  label={copy.projectLayoutList}
                  onClick={() => onProjectLayoutChange('list')}
                />
              </div>
              <label className="settings-tool-row mt-3">
                <span>
                  <span className="block font-medium text-ink">{copy.usageStrip}</span>
                  <span className="mt-1 block text-meta leading-5 text-ink-500">
                    {copy.usageStripHint}
                  </span>
                </span>
                <input
                  checked={showUsageStrip}
                  className="settings-switch"
                  onChange={(event) => onShowUsageStripChange(event.target.checked)}
                  type="checkbox"
                />
              </label>
            </div>
          </section>

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

          <DeviceProvisioningPanel copy={copy.deviceProvisioning} />
        </div>
      </section>
    </div>
  )
}

function HudEffectOption({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={`hud-effect-option ${active ? 'is-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span className="hud-effect-dot" aria-hidden="true" />
      <span>{label}</span>
    </button>
  )
}

function HudLayoutOption({
  active,
  label,
  onClick,
}: {
  active: boolean
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      aria-pressed={active}
      className={`hud-effect-option ${active ? 'is-active' : ''}`}
      onClick={onClick}
      type="button"
    >
      <span>{label}</span>
    </button>
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
  if (tool === 'grok') return copy.grok
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

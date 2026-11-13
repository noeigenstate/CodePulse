import { useCallback, useEffect, useState } from 'react'
import type { StorageLike } from './ambientSocial.js'

/** What the shortcut needs to know about the element a key press landed on. */
interface ShortcutTarget {
  tagName?: string
  type?: string
  isContentEditable?: boolean
}

/** The slice of a `KeyboardEvent` the sidebar shortcut reads, so tests need no DOM. */
export interface RailShortcutEvent {
  key: string
  /** Physical key (`KeyB`); empty when the event carries none. */
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  defaultPrevented: boolean
  /** A DOM element in the app; typed loosely so a plain object works in tests. */
  target: object | null
}

/** How the shortcut is written for people and for assistive technology. */
export interface RailShortcutHint {
  text: string
  aria: string
}

const STORAGE_KEY = 'codepulse.railCollapsed'
/** Inputs that take no typing, so B stays a shortcut there (a switch on the settings page, say). */
const NON_TEXT_INPUT_TYPES = [
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]

/** The window's `localStorage`, or `undefined` where it is absent or blocked (tests, privacy modes). */
export function railStorage(): StorageLike | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

/**
 * Reads whether the main window's sidebar was left collapsed.
 *
 * Anything other than the value this module writes (missing, unreadable or foreign) means expanded.
 *
 * @param storage Browser storage, or `undefined` for non-browser callers.
 */
export function readRailCollapsed(storage: StorageLike | undefined): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

/** Best-effort persists the sidebar state; the in-memory choice survives unavailable storage. */
export function writeRailCollapsed(storage: StorageLike | undefined, value: boolean): void {
  try {
    storage?.setItem(STORAGE_KEY, value ? '1' : '0')
  } catch {
    // Storage may be full or blocked; the sidebar still toggles for this session.
  }
}

/** The shortcut as shown on the toggle: ⌘B on macOS, Ctrl+B elsewhere. */
export function railShortcutHint(platform: string | undefined): RailShortcutHint {
  return platform === 'darwin'
    ? { text: '⌘B', aria: 'Meta+B' }
    : { text: 'Ctrl+B', aria: 'Control+B' }
}

/**
 * Whether a key press is the sidebar shortcut: Ctrl+B, or ⌘B on macOS.
 *
 * It matches the physical key so other layouts work, and falls back to the typed key when the
 * event has no code. Another handler that already used the key, typing in a text field (a switch
 * or a drop-down keeps the shortcut) leave the key alone. The listener checks modal layers next.
 */
export function isRailShortcut(event: RailShortcutEvent, platform?: string): boolean {
  if (event.defaultPrevented || event.repeat) return false
  const modifier =
    platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  if (!modifier || event.altKey || event.shiftKey) return false
  if (event.code ? event.code !== 'KeyB' : event.key.toLowerCase() !== 'b') return false
  const {
    tagName = '',
    type = 'text',
    isContentEditable = false,
  } = (event.target ?? {}) as ShortcutTarget
  if (isContentEditable) return false
  switch (tagName.toUpperCase()) {
    case 'TEXTAREA':
      return false
    case 'INPUT':
      return NON_TEXT_INPUT_TYPES.includes(type.toLowerCase())
    default:
      return true
  }
}

/** Whether a modal layer is currently on screen. */
export function hasOpenModal(root: ParentNode = document): boolean {
  return Array.from(root.querySelectorAll('[aria-modal="true"]')).some((layer) => {
    if (!layer.getClientRects().length) return false
    const style = layer.ownerDocument?.defaultView?.getComputedStyle(layer)
    return !style || style.visibility === 'visible'
  })
}

/**
 * The main window's sidebar state: remembered across launches and toggled by the shortcut.
 *
 * @param enabled Only the main client has a sidebar; independent screen windows leave the key alone.
 */
export function useRailCollapsed(
  enabled: boolean,
  platform?: string,
): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState(() => readRailCollapsed(railStorage()))
  useEffect(() => {
    if (enabled) writeRailCollapsed(railStorage(), collapsed)
  }, [enabled, collapsed])
  const toggle = useCallback(() => setCollapsed((current) => !current), [])
  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isRailShortcut(event, platform) || hasOpenModal()) return
      event.preventDefault()
      toggle()
    }
    // Bubble phase on window: a handler that used the key first leaves it defaultPrevented.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, platform, toggle])
  return { collapsed, toggle }
}

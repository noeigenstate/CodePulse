import { TurnState, type OverallState, type StatusSnapshot } from '@codepulse/shared'
import { normalizeWindowTheme, type WindowTheme } from './window-chrome.js'

/** Electron uses AARRGGBB for BrowserWindow background colors. */
export const HUD_TRANSPARENT_BACKGROUND = '#00000000'
export const HUD_WINDOW_OPACITY = 1
export const HUD_WINDOW_MARGIN = 24
/** A narrow right-hand lane keeps the HUD project-first instead of dashboard-like. */
export const HUD_WINDOW_PREFERRED_SIZE = { width: 640, height: 240 } as const
export const HUD_WINDOW_MIN_SIZE = { width: 560, height: 132 } as const
export const HUD_WINDOW_SHELL_OPTIONS = {
  transparent: true,
  frame: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  opacity: HUD_WINDOW_OPACITY,
  backgroundColor: HUD_TRANSPARENT_BACKGROUND,
} as const

export interface HudRectangle {
  x: number
  y: number
  width: number
  height: number
}

export interface HudDisplay {
  id: number
  bounds: HudRectangle
  workArea: HudRectangle
}

export interface HudWindowSurface {
  isDestroyed(): boolean
  setBackgroundColor(color: string): void
  setOpacity(opacity: number): void
}

export interface HudRevealTarget {
  isDestroyed(): boolean
  showInactive(): void
}

/**
 * Chooses a companion display without depending on Electron globals.
 *
 * A display fully to the right of the primary display wins. When there are
 * several, the right-most one wins. Layouts without a right-hand display use
 * the right-most remaining secondary, and single-display systems use primary.
 */
export function selectHudDisplay(
  displays: readonly HudDisplay[],
  primaryDisplayId: number,
): HudDisplay | undefined {
  if (displays.length === 0) return undefined

  const primary = displays.find((display) => display.id === primaryDisplayId) ?? displays[0]!
  const secondary = displays.filter((display) => display !== primary)
  if (secondary.length === 0) return primary

  const primaryRight = primary.bounds.x + primary.bounds.width
  const rightHandDisplays = secondary.filter((display) => display.bounds.x >= primaryRight)
  return [...(rightHandDisplays.length > 0 ? rightHandDisplays : secondary)].sort(
    compareRightMost,
  )[0]
}

/** Returns a clamped, top-right HUD rectangle inside a display's work area. */
export function hudWindowBoundsForDisplay(
  display: HudDisplay,
  preferredSize: Readonly<{ width: number; height: number }> = HUD_WINDOW_PREFERRED_SIZE,
  requestedMargin: number = HUD_WINDOW_MARGIN,
): HudRectangle {
  const workArea = normalizedRectangle(display.workArea)
  const margin = finiteNonNegativeInteger(requestedMargin, HUD_WINDOW_MARGIN)
  const marginX = Math.min(margin, Math.floor(Math.max(0, workArea.width - 1) / 2))
  const marginY = Math.min(margin, Math.floor(Math.max(0, workArea.height - 1) / 2))
  const maxWidth = Math.max(1, workArea.width - marginX * 2)
  const maxHeight = Math.max(1, workArea.height - marginY * 2)
  const minWidth = Math.min(HUD_WINDOW_MIN_SIZE.width, maxWidth)
  const minHeight = Math.min(HUD_WINDOW_MIN_SIZE.height, maxHeight)
  const preferredWidth = finitePositiveInteger(preferredSize.width, HUD_WINDOW_PREFERRED_SIZE.width)
  const preferredHeight = finitePositiveInteger(
    preferredSize.height,
    HUD_WINDOW_PREFERRED_SIZE.height,
  )
  const width = clamp(preferredWidth, minWidth, maxWidth)
  const height = clamp(preferredHeight, minHeight, maxHeight)

  return {
    x: workArea.x + workArea.width - marginX - width,
    y: workArea.y + marginY,
    width,
    height,
  }
}

/**
 * Clamps renderer-measured content height to the usable display lane.
 *
 * The project deck reports its natural header + rows + usage-strip height so
 * the native transparent window does not leave a large inert region behind a
 * short project list.
 */
export function hudContentHeightForDisplay(
  requestedHeight: number,
  display: HudDisplay,
  requestedMargin: number = HUD_WINDOW_MARGIN,
): number {
  const workArea = normalizedRectangle(display.workArea)
  const margin = finiteNonNegativeInteger(requestedMargin, HUD_WINDOW_MARGIN)
  const marginY = Math.min(margin, Math.floor(Math.max(0, workArea.height - 1) / 2))
  const maximum = Math.max(1, workArea.height - marginY * 2)
  const minimum = Math.min(HUD_WINDOW_MIN_SIZE.height, maximum)
  return clamp(finitePositiveInteger(requestedHeight, minimum), minimum, maximum)
}

/** Keeps the native surface fully opaque while its background remains transparent. */
export function preserveHudWindowSurface(targetWindow: HudWindowSurface | null): void {
  if (!targetWindow || targetWindow.isDestroyed()) return
  targetWindow.setBackgroundColor(HUD_TRANSPARENT_BACKGROUND)
  targetWindow.setOpacity(HUD_WINDOW_OPACITY)
}

/** Normalizes a renderer theme while preserving the transparent native HUD surface. */
export function applyHudWindowTheme(
  value: unknown,
  targetWindow: HudWindowSurface | null,
): WindowTheme {
  preserveHudWindowSurface(targetWindow)
  return normalizeWindowTheme(value)
}

/** Shows a HUD without calling focus/show or otherwise activating the window. */
export function showHudInactive(targetWindow: HudRevealTarget | null): boolean {
  if (!targetWindow || targetWindow.isDestroyed()) return false
  targetWindow.showInactive()
  return true
}

/** States that should reveal the passive HUD instead of creating an OS toast. */
export function shouldRevealHud(overall: OverallState): boolean {
  switch (overall) {
    case 'attention':
    case 'done_unread':
    case 'error':
    case 'stuck':
    case 'limited':
      return true
    case 'idle':
    case 'running':
      return false
  }
}

/**
 * Derives the desktop HUD's aggregate signal from every visible project.
 *
 * The transport-level aggregate intentionally ranks active work above an
 * unread completion. That is useful for compact device status, but a companion
 * HUD must not let one running project hide another project's notification.
 * Acknowledged terminal states remain in the dashboard for their normal TTL
 * without keeping the tray orange.
 */
export function deriveHudOverall(snapshot: StatusSnapshot): OverallState {
  const agents = snapshot.agents.filter((agent) => !agent.taskHidden)
  const hasUnread = (state: TurnState): boolean =>
    agents.some((agent) => agent.state === state && agent.unread)
  const hasState = (...states: TurnState[]): boolean =>
    agents.some((agent) => states.includes(agent.state))

  if (hasUnread(TurnState.ERROR)) return 'error'
  if (hasUnread(TurnState.USAGE_LIMITED)) return 'limited'
  if (hasUnread(TurnState.TIMEOUT)) return 'stuck'
  if (hasState(TurnState.WAITING_PERMISSION, TurnState.WAITING_USER_INPUT)) return 'attention'
  if (hasUnread(TurnState.DONE)) return 'done_unread'
  if (hasState(TurnState.PROMPT_SUBMITTED, TurnState.THINKING, TurnState.TOOL_RUNNING)) {
    return 'running'
  }
  return 'idle'
}

function compareRightMost(left: HudDisplay, right: HudDisplay): number {
  const rightEdgeDelta = displayRightEdge(right) - displayRightEdge(left)
  if (rightEdgeDelta !== 0) return rightEdgeDelta
  const xDelta = right.bounds.x - left.bounds.x
  if (xDelta !== 0) return xDelta
  return left.id - right.id
}

function displayRightEdge(display: HudDisplay): number {
  return display.bounds.x + display.bounds.width
}

function normalizedRectangle(rectangle: HudRectangle): HudRectangle {
  return {
    x: Number.isFinite(rectangle.x) ? Math.round(rectangle.x) : 0,
    y: Number.isFinite(rectangle.y) ? Math.round(rectangle.y) : 0,
    width: finitePositiveInteger(rectangle.width, 1),
    height: finitePositiveInteger(rectangle.height, 1),
  }
}

function finitePositiveInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : fallback
}

function finiteNonNegativeInteger(value: number, fallback: number): number {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

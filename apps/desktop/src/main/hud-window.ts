import {
  TurnState,
  type AgentRuntimeState,
  type HudAppearanceSettings,
  type HudOrbPosition,
  type HudStageInfo,
  type HudSurfaceStyle,
  type HudToolKey,
  type OverallState,
  type StatusSnapshot,
} from '@codepulse/shared'
import { normalizeWindowTheme, type WindowTheme } from './window-chrome.js'

/** Electron uses AARRGGBB for BrowserWindow background colors. */
export const HUD_TRANSPARENT_BACKGROUND = '#00000000'
export const HUD_WINDOW_OPACITY = 1
export const HUD_WINDOW_MARGIN = 24
/** A narrow right-hand lane keeps the HUD project-first instead of dashboard-like. */
export const HUD_WINDOW_PREFERRED_SIZE = { width: 470, height: 240 } as const
export const HUD_WINDOW_MIN_SIZE = { width: 470, height: 132 } as const
export const HUD_ORB_SIZE = 56
export const HUD_ORB_INSET = 24
const HUD_ORB_MARGIN = 8
const HUD_STAGE_SIZES = {
  island: { width: 508, height: 460 },
  pills: { width: 388, height: 720 },
  edge: { width: 460, height: 640 },
  orb: { width: 448, height: 504 },
} as const
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

export function defaultHudOrbPosition(display: HudDisplay): HudOrbPosition {
  const area = normalizedRectangle(display.workArea)
  return clampHudOrbPosition(
    { x: area.x + area.width - 48 - HUD_ORB_SIZE, y: area.y + 64 },
    display,
  )
}

/** Keeps the visible orb inside the work area; transparent stage pixels may extend beyond it. */
export function clampHudOrbPosition(position: HudOrbPosition, display: HudDisplay): HudOrbPosition {
  const area = normalizedRectangle(display.workArea)
  const marginX = Math.min(HUD_ORB_MARGIN, Math.max(0, Math.floor((area.width - HUD_ORB_SIZE) / 2)))
  const marginY = Math.min(
    HUD_ORB_MARGIN,
    Math.max(0, Math.floor((area.height - HUD_ORB_SIZE) / 2)),
  )
  return {
    x: clamp(
      Math.round(position.x),
      area.x + marginX,
      Math.max(area.x + marginX, area.x + area.width - marginX - HUD_ORB_SIZE),
    ),
    y: clamp(
      Math.round(position.y),
      area.y + marginY,
      Math.max(area.y + marginY, area.y + area.height - marginY - HUD_ORB_SIZE),
    ),
  }
}

export function hudOrbPositionForStage(bounds: HudRectangle, stage: HudStageInfo): HudOrbPosition {
  return {
    x:
      bounds.x +
      (stage.anchorH === 'right' ? bounds.width - HUD_ORB_INSET - HUD_ORB_SIZE : HUD_ORB_INSET),
    y:
      bounds.y +
      (stage.anchorV === 'bottom' ? bounds.height - HUD_ORB_INSET - HUD_ORB_SIZE : HUD_ORB_INSET),
  }
}

/** Fixed native stages leave all surface morphing to the renderer. Coordinates are DIP. */
export function hudStageForStyle(
  style: HudSurfaceStyle,
  display: HudDisplay,
  orbPosition?: HudOrbPosition,
): { bounds: HudRectangle; stage: HudStageInfo } {
  const stage: HudStageInfo = { style, anchorH: 'right', anchorV: 'top' }
  if (style === 'panel') return { bounds: hudWindowBoundsForDisplay(display), stage }
  const area = normalizedRectangle(display.workArea)
  const width = Math.min(HUD_STAGE_SIZES[style].width, area.width)
  const height = Math.min(HUD_STAGE_SIZES[style].height, area.height)
  if (style !== 'orb') {
    return {
      bounds: {
        x:
          area.x + (style === 'island' ? Math.floor((area.width - width) / 2) : area.width - width),
        y: area.y,
        width,
        height,
      },
      stage,
    }
  }
  const position =
    orbPosition && Number.isFinite(orbPosition.x) && Number.isFinite(orbPosition.y)
      ? clampHudOrbPosition(orbPosition, display)
      : defaultHudOrbPosition(display)
  stage.anchorH = position.x + HUD_ORB_SIZE / 2 >= area.x + area.width / 2 ? 'right' : 'left'
  stage.anchorV = position.y + HUD_ORB_SIZE / 2 >= area.y + area.height / 2 ? 'bottom' : 'top'
  const offset = hudOrbPositionForStage({ x: 0, y: 0, width, height }, stage)
  return { bounds: { x: position.x - offset.x, y: position.y - offset.y, width, height }, stage }
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

/** Keep a manually opened HUD inside the invoking client's display, preserving a valid position. */
export function hudWindowBoundsForReveal(
  display: HudDisplay,
  current?: HudRectangle,
): HudRectangle {
  const preferred = hudWindowBoundsForDisplay(display, current)
  const area = normalizedRectangle(display.workArea)
  if (
    !current ||
    current.x + current.width <= area.x ||
    current.x >= area.x + area.width ||
    current.y + current.height <= area.y ||
    current.y >= area.y + area.height
  )
    return preferred
  return {
    ...preferred,
    x: clamp(current.x, area.x, area.x + area.width - preferred.width),
    y: clamp(current.y, area.y, area.y + area.height - preferred.height),
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

/** Session scans can refresh lastEventAt without producing a new terminal result. */
export function hudAlertKeys(
  agents: readonly AgentRuntimeState[],
  visibleTools: HudAppearanceSettings['visibleTools'],
  now: number,
): Set<string> {
  const keys = new Set<string>()
  for (const agent of agents) {
    const timestamp = agent.terminalAt ?? agent.lastEventAt
    if (
      agent.taskHidden ||
      !visibleTools[agent.agentType as HudToolKey] ||
      !Number.isFinite(timestamp) ||
      timestamp > now ||
      now - timestamp > 60_000 ||
      !shouldRevealHud(deriveHudOverall({ agents: [agent], overall: 'idle', updatedAt: now }))
    )
      continue
    keys.add(
      JSON.stringify([
        agent.agentType,
        agent.externalSessionId ?? agent.workspacePath ?? '',
        agent.state,
        timestamp,
      ]),
    )
  }
  return keys
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

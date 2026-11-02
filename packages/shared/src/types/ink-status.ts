import type { DeviceDisplayConfig } from './device-display.js'
import type { InkDisplayMode, InkDisplayPlan, InkFeatureId } from './product-shell.js'

/** One-off display of a desk card or the todo list; the playlist resumes when it ends. */
export const INK_TEMPORARY_MINUTES = 10
/** A device that read its status within this window counts as connected. */
export const INK_CONNECTED_WINDOW_MS = 90_000

/** `server-off`: the LAN device service is not enabled, so no device can connect. */
export type InkConnection = 'connected' | 'disconnected' | 'server-off'

/** What the e-ink screen renders now, or will render as soon as a device connects. */
export type InkShowing =
  | { kind: 'work' }
  | { kind: 'ambient' | 'todos'; title: string }

/**
 * Single source for "what is on the e-ink screen" across every desktop page.
 * Computed in the main process from the applied playlist, the device projection,
 * temporary displays and the last device request; the renderer never derives it.
 */
export interface InkScreenStatus {
  connection: InkConnection
  /** Last authenticated status read from a device (epoch ms), or null when none yet. */
  lastSeenAt: number | null
  showing: InkShowing
  /** Active one-off display, or null. `until` is epoch ms. */
  temporary: { kind: 'ambient' | 'todos'; title: string; until: number } | null
  /** Applied playlist mode and the slot it selects now. */
  mode: InkDisplayMode
  current: InkFeatureId
  /** Next playlist slot and when it starts; null in fixed mode or with one slot. */
  next: { feature: InkFeatureId; at: number } | null
  /** Why the current slot shows the work screen instead (e.g. daily limit reached); '' when not applicable. */
  slotNote: string
  updatedAt: number
}

/** Applied together by the main process: the playlist plus the work-screen details. */
export interface InkApplyRequest {
  plan: InkDisplayPlan
  display: DeviceDisplayConfig
}

import type { AgentType, HudDragPhase, HudStageInfo, HudSurfaceStyle } from '@codepulse/shared'
import type { CompactSummary, CompactTask } from '../../lib/hudCompact.js'
import type { HudHitTest } from '../../lib/useHudHitTest.js'
import type { Locale, UiCopy } from '../../lib/i18n.js'
import type { ProjectUsageSummary } from '../../lib/projectDeck.js'

/** Compact styles only; `panel` is rendered by ProjectDeck. */
export type CompactStyle = Exclude<HudSurfaceStyle, 'panel'>

/** Main-process window controls for the transparent stage. Absent in read-only previews. */
export interface HudCompactBridge {
  setInteractive: (interactive: boolean) => unknown
  drag: (phase: HudDragPhase) => unknown
  getStage: () => Promise<HudStageInfo>
  onStage: (callback: (stage: HudStageInfo) => void) => () => void
}

export type AckHandler = (
  agentType: AgentType,
  workspacePath?: string,
  externalSessionId?: string,
) => void

/** Everything the task list, rows and peek lines need; shared by all four styles. */
export interface ListProps {
  allToolsHidden: boolean
  copy: UiCopy
  locale: Locale
  now: number
  onAck: AckHandler
  onDismiss: AckHandler
  showUsageStrip: boolean
  tasks: CompactTask[]
  usage: ProjectUsageSummary[]
}

export interface SurfaceProps {
  list: ListProps
  onToggle: () => void
  open: boolean
  /** The task a collapsed surface should talk about, if any. */
  peek: CompactTask | undefined
  summary: CompactSummary
}

export interface OrbProps extends SurfaceProps {
  bridge: HudCompactBridge | undefined
  hit: HudHitTest
  stage: HudStageInfo | undefined
}

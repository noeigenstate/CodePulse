import type { AgentRuntimeState } from '@codepulse/shared'
import { hudStateLevel, type HudStateLevel } from './hudState.js'
import { projectCardTitle, type ProjectDeckCard, type ProjectDeckGroup } from './projectDeck.js'

/** One card of the project deck, flattened for the compact surfaces. */
export interface CompactTask {
  card: ProjectDeckCard
  group: ProjectDeckGroup
  title: string
  level: HudStateLevel
}

export interface CompactSummary {
  /** Tasks the agent is still working on. */
  running: number
  /** Finished or failed tasks the user has not acknowledged. */
  unread: number
}

/** How long a notice stays peeked before only its unread mark remains. */
export const COMPACT_NOTICE_PEEK_MS = 5_000

/** Largest open island, in px; the list scrolls past it. */
export const ISLAND_OPEN_MAX_HEIGHT = 420

export interface IslandBox {
  width: number
  height: number
  radius: number
}

/** Sizes from the design: the collapsed text decides the width; a peek is 420x64. */
export function islandBox(input: {
  open: boolean
  peeking: boolean
  summary: CompactSummary
  listHeight: number
}): IslandBox {
  const { open, peeking, summary, listHeight } = input
  if (open) return { width: 460, height: Math.min(listHeight, ISLAND_OPEN_MAX_HEIGHT), radius: 16 }
  if (peeking) return { width: 420, height: 64, radius: 32 }
  if (summary.running > 0 && summary.unread > 0) return { width: 272, height: 36, radius: 18 }
  if (summary.running > 0 || summary.unread > 0) return { width: 216, height: 36, radius: 18 }
  return { width: 128, height: 36, radius: 18 }
}

const LEVEL_RANK: Partial<Record<HudStateLevel, number>> = {
  fault: 4,
  action: 3,
  notice: 2,
  active: 1,
}
const PEEK_RANK: Partial<Record<HudStateLevel, number>> = { fault: 2, action: 1 }

/** Keeps the deck's stable list order; the compact surfaces never reorder tasks. */
export function flattenTasks(
  groups: readonly ProjectDeckGroup[],
  unknownTitle: string,
): CompactTask[] {
  return groups.flatMap((group) =>
    group.cards.map((card) => ({
      card,
      group,
      title: projectCardTitle(card, group) || unknownTitle,
      level: hudStateLevel(card.agent),
    })),
  )
}

export function summarize(tasks: readonly CompactTask[]): CompactSummary {
  return {
    running: tasks.filter((task) => task.level === 'active').length,
    unread: tasks.filter((task) => task.level === 'notice' || task.level === 'fault').length,
  }
}

/** Identity of one alert: the same card in the same state at the same moment. */
export function peekKey(task: CompactTask): string {
  const agent: AgentRuntimeState = task.card.agent
  return `${task.card.id}|${agent.state}|${agent.terminalAt ?? agent.lastEventAt}`
}

/** The task with the most urgent level, first in list order on a tie; `quiet` counts as none. */
export function topTask(tasks: readonly CompactTask[]): CompactTask | undefined {
  let best: CompactTask | undefined
  let bestRank = 0
  for (const task of tasks) {
    const rank = LEVEL_RANK[task.level] ?? 0
    if (rank > bestRank) {
      best = task
      bestRank = rank
    }
  }
  return best
}

/** Largest orb popup, in px; the list scrolls past it. */
export const ORB_POPUP_MAX_HEIGHT = 392
const ORB_POPUP_MIN_HEIGHT = 96
const ORB_POPUP_OFFSET = 88
const ORB_POPUP_MARGIN = 8

/**
 * Room for the orb popup on short displays. The popup starts 88px from the stage edge
 * next to the orb and opens toward the other edge; it may use the display work area
 * minus a small margin, never more than 392px and never less than a few rows.
 */
export function orbPopupMaxHeight(input: {
  anchorV: 'top' | 'bottom'
  /** `window.screenY` and `window.innerHeight` of the stage window. */
  windowY: number
  stageHeight: number
  /** `screen.availTop` and `screen.availHeight` of the display holding the window. */
  availTop: number
  availHeight: number
}): number {
  const { anchorV, windowY, stageHeight, availTop, availHeight } = input
  const room =
    anchorV === 'top'
      ? availTop + availHeight - (windowY + ORB_POPUP_OFFSET) - ORB_POPUP_MARGIN
      : windowY + stageHeight - ORB_POPUP_OFFSET - availTop - ORB_POPUP_MARGIN
  if (!Number.isFinite(room)) return ORB_POPUP_MAX_HEIGHT
  return Math.round(Math.max(ORB_POPUP_MIN_HEIGHT, Math.min(ORB_POPUP_MAX_HEIGHT, room)))
}

/** Fault and action alerts stay until the state changes; a notice peeks once. */
export function isUrgent(task: CompactTask | undefined): boolean {
  return task?.level === 'fault' || task?.level === 'action'
}

/**
 * The task a collapsed surface should talk about: the highest-priority fault or
 * action task always, otherwise the first notice that has not been peeked yet.
 */
export function pickPeek(
  tasks: readonly CompactTask[],
  spentKeys: ReadonlySet<string>,
): CompactTask | undefined {
  let urgent: CompactTask | undefined
  for (const task of tasks) {
    const rank = PEEK_RANK[task.level]
    if (rank && rank > (urgent ? (PEEK_RANK[urgent.level] ?? 0) : 0)) urgent = task
  }
  if (urgent) return urgent
  return tasks.find((task) => task.level === 'notice' && !spentKeys.has(peekKey(task)))
}

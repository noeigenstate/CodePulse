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
  total: number
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
    total: tasks.length,
    running: tasks.filter((task) => task.level === 'active').length,
    unread: tasks.filter((task) => task.level === 'notice' || task.level === 'fault').length,
  }
}

/** Identity of one alert: the same card in the same state at the same moment. */
export function peekKey(task: CompactTask): string {
  const agent: AgentRuntimeState = task.card.agent
  return `${task.card.id}|${agent.state}|${agent.terminalAt ?? agent.lastEventAt}`
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

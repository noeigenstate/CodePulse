/**
 * Stable, renderer-only project ordering for dashboard panels.
 *
 * Project positions are keyed by normalized workspace path and persisted in
 * browser storage. Runtime activity may update a card, but it must not move it.
 *
 * @module renderer/projectOrder
 */
import { workspaceKey } from '@codepulse/shared'
import type { AgentPanel, AgentWorkspaceItem } from './displayAgents.js'

/** Maximum number of historical project positions retained between app launches. */
export const PROJECT_ORDER_LIMIT = 2_048

const STORAGE_KEY = 'codepulse:project-order-v1'

interface StorageLike {
  /** Reads a persisted value by key. */
  getItem(key: string): string | null
  /** Persists a value by key. */
  setItem(key: string, value: string): void
}

interface StoredProjectOrder {
  version: 1
  workspaceKeys: string[]
}

/** Result of reconciling persisted positions with the currently visible projects. */
export interface ProjectOrderResult {
  /** Panels whose project arrays follow the stable persisted order. */
  panels: AgentPanel[]
  /** Updated global workspace order, including temporarily absent projects. */
  order: string[]
  /** Whether the updated order needs to be persisted. */
  changed: boolean
}

/**
 * Reads and validates the persisted project order.
 *
 * Malformed, inaccessible, duplicate, or empty entries are discarded. Storage
 * failures return an empty order so the current renderer session can continue.
 *
 * @param storage Browser storage, or `undefined` when storage is unavailable.
 * @returns A normalized, duplicate-free project order.
 */
export function readProjectOrder(storage: StorageLike | undefined): string[] {
  let raw: string | null | undefined
  try {
    raw = storage?.getItem(STORAGE_KEY)
  } catch {
    return []
  }
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.workspaceKeys)) return []
    return normalizeOrder(parsed.workspaceKeys).slice(0, PROJECT_ORDER_LIMIT)
  } catch {
    return []
  }
}

/**
 * Persists a normalized project order without interrupting the dashboard.
 *
 * @param storage Browser storage, or `undefined` when storage is unavailable.
 * @param order Global normalized workspace order to save.
 */
export function writeProjectOrder(
  storage: StorageLike | undefined,
  order: readonly string[],
): void {
  const snapshot: StoredProjectOrder = {
    version: 1,
    workspaceKeys: normalizeOrder(order).slice(0, PROJECT_ORDER_LIMIT),
  }
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    // Keep the in-memory order when browser storage is unavailable or full.
  }
}

/**
 * Appends newly observed projects and applies the resulting order to every CLI panel.
 *
 * The order is global across CLI types, so the same workspace keeps the same
 * relative position in Codex, Claude Code, Grok, and Kimi panels. Temporarily
 * absent workspaces remain in the order and regain their previous position when
 * they reappear. When the history exceeds its bound, oldest absent entries are
 * removed first; currently displayed projects are never discarded.
 *
 * @param panels Unfiltered dashboard panels built from the latest status snapshot.
 * @param previousOrder Previously persisted normalized workspace order.
 * @returns Ordered panels plus any updated order that should be persisted.
 */
export function reconcileProjectOrder(
  panels: readonly AgentPanel[],
  previousOrder: readonly string[],
): ProjectOrderResult {
  const normalizedPrevious = normalizeOrder(previousOrder)
  const liveKeys = collectWorkspaceKeys(panels)
  const knownKeys = new Set(normalizedPrevious)
  let nextOrder = [...normalizedPrevious]

  for (const key of liveKeys) {
    if (knownKeys.has(key)) continue
    knownKeys.add(key)
    nextOrder.push(key)
  }

  nextOrder = trimOrder(nextOrder, new Set(liveKeys))
  const changed = !sameStrings(previousOrder, nextOrder)
  const ranks = new Map(nextOrder.map((key, index) => [key, index]))

  return {
    panels: panels.map((panel) => orderPanel(panel, ranks)),
    order: nextOrder,
    changed,
  }
}

/**
 * Selects the most recently updated project independently from visual order.
 *
 * @param items Stably ordered project cards in one CLI panel.
 * @returns The project with the greatest update timestamp, when one exists.
 */
export function latestProjectItem(
  items: readonly AgentWorkspaceItem[],
): AgentWorkspaceItem | undefined {
  let latest: AgentWorkspaceItem | undefined
  for (const item of items) {
    if (!latest || item.updatedAt > latest.updatedAt) latest = item
  }
  return latest
}

/**
 * Collects unique normalized workspace keys in first-observed panel order.
 *
 * @param panels Current unfiltered dashboard panels.
 * @returns Unique project keys shared across all CLI types.
 */
function collectWorkspaceKeys(panels: readonly AgentPanel[]): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const panel of panels) {
    for (const item of panel.workspaces) {
      const key = workspaceKey(item.workspacePath)
      if (!key || seen.has(key)) continue
      seen.add(key)
      keys.push(key)
    }
  }
  return keys
}

/**
 * Orders one panel without mutating the panel produced by display aggregation.
 *
 * @param panel Panel whose project cards need stable positions.
 * @param ranks Global workspace ranks shared by every panel.
 * @returns The original panel when already ordered, otherwise a shallow clone.
 */
function orderPanel(panel: AgentPanel, ranks: ReadonlyMap<string, number>): AgentPanel {
  const workspaces = [...panel.workspaces].sort((a, b) => {
    const aKey = workspaceKey(a.workspacePath)
    const bKey = workspaceKey(b.workspacePath)
    return (
      (ranks.get(aKey) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(bKey) ?? Number.MAX_SAFE_INTEGER) ||
      aKey.localeCompare(bKey)
    )
  })
  if (workspaces.every((item, index) => item === panel.workspaces[index])) return panel
  return { ...panel, workspaces }
}

/**
 * Normalizes and deduplicates untrusted workspace-order entries.
 *
 * @param values Candidate workspace keys from memory or persisted JSON.
 * @returns Valid keys in their original relative order.
 */
function normalizeOrder(values: readonly unknown[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    if (typeof value !== 'string') continue
    const key = workspaceKey(value.trim())
    if (!key || seen.has(key)) continue
    seen.add(key)
    normalized.push(key)
  }
  return normalized
}

/**
 * Applies the history bound while preserving every currently displayed project.
 *
 * @param order Complete historical order after appending new projects.
 * @param liveKeys Workspaces currently present in at least one panel.
 * @returns A bounded order with oldest absent entries removed first.
 */
function trimOrder(order: readonly string[], liveKeys: ReadonlySet<string>): string[] {
  let excess = Math.max(0, order.length - PROJECT_ORDER_LIMIT)
  if (excess === 0) return [...order]

  return order.filter((key) => {
    if (excess === 0 || liveKeys.has(key)) return true
    excess -= 1
    return false
  })
}

/**
 * Compares two string sequences without allocating serialized copies.
 *
 * @param left First sequence.
 * @param right Second sequence.
 * @returns `true` when both sequences contain identical values in identical order.
 */
function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/** Narrows parsed JSON to a non-null object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

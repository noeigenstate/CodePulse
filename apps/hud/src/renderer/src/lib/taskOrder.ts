import { workspaceKey } from '@codepulse/shared'
import type { AgentPanel } from './displayAgents.js'

const STORAGE_KEY = 'codepulse:task-order-v1'
const LIMIT = 2048
interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function validIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value.filter(
        (id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 2048,
      ),
    ),
  ]
}

export function readTaskOrder(storage?: StorageLike): string[] {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')
    return saved?.version === 1 ? validIds(saved.ids).slice(-LIMIT) : []
  } catch {
    return []
  }
}

export function writeTaskOrder(storage: StorageLike | undefined, order: readonly string[]): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: validIds(order) }))
  } catch {
    /* Keep the current in-memory order if storage is unavailable. */
  }
}

/** Runs after project ordering. Only sibling task positions are refined. */
export function reconcileTaskOrder(panels: readonly AgentPanel[], previous: readonly string[]) {
  const live = new Set(panels.flatMap((panel) => panel.workspaces.map((item) => item.id)))
  const order = validIds([...previous, ...live])
  let excess = Math.max(0, order.length - LIMIT)
  const retained = order.filter((id) => {
    if (!excess || live.has(id)) return true
    excess--
    return false
  })
  const ranks = new Map(retained.map((id, i) => [id, i]))
  return {
    order: retained,
    changed: retained.length !== previous.length || retained.some((id, i) => id !== previous[i]),
    panels: panels.map((panel) => {
      const groups = new Map<string, number>()
      for (const item of panel.workspaces) {
        const key = workspaceKey(item.workspacePath)
        if (!groups.has(key)) groups.set(key, groups.size)
      }
      const workspaces = [...panel.workspaces].sort(
        (a, b) =>
          groups.get(workspaceKey(a.workspacePath))! - groups.get(workspaceKey(b.workspacePath))! ||
          ranks.get(a.id)! - ranks.get(b.id)!,
      )
      return { ...panel, workspaces }
    }),
  }
}

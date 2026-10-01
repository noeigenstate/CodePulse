import type { StatusSnapshot } from '@codepulse/shared'

/**
 * Build a semantic key for a snapshot, intentionally ignoring `updatedAt`.
 * Polling can refresh `updatedAt` without changing agent data; that should not
 * trigger a renderer-wide update.
 */
export function snapshotDataKey(snapshot: StatusSnapshot): string {
  return JSON.stringify({
    overall: snapshot.overall,
    agents: snapshot.agents,
  })
}

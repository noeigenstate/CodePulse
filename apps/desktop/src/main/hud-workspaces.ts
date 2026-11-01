import { createHash } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { AgentRuntimeState } from '@codepulse/shared'

export const HUD_WORKSPACE_LIMIT = 2048

/** Execution cwd is mutable; a native session remains the same HUD project. */
export function hudRowKey(agent: AgentRuntimeState): string {
  const identity = agent.externalSessionId
    ? [agent.agentType, 'session', agent.externalSessionId]
    : [agent.agentType, 'workspace', hudWorkspacePath(agent.workspacePath)?.toLowerCase() ?? '']
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}

/** Native app metadata uses file URIs while hooks use filesystem paths. */
export function hudWorkspacePath(value: string | undefined): string | undefined {
  let path = value?.trim()
  if (!path) return undefined
  if (/^file:/i.test(path)) {
    try {
      const url = new URL(path)
      path = decodeURIComponent(url.pathname)
      if (url.hostname && url.hostname !== 'localhost') path = `//${url.hostname}${path}`
      else if (/^\/[a-z]:\//i.test(path)) path = path.slice(1)
    } catch {
      /* Preserve malformed input without throwing away the task. */
    }
  }
  return path.replace(/\\/g, '/').replace(/\/+$/, '') || undefined
}

/** HUD-only bindings. No prompts, tokens or raw session IDs are persisted. */
export class HudWorkspaces {
  private bindings = new Map<string, string>()

  constructor(
    private path?: string,
    private onError: (error: unknown) => void = () => {},
  ) {
    if (!path) return
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8'))
      if (saved?.version !== 1 || !Array.isArray(saved.bindings)) return
      for (const entry of saved.bindings.slice(-HUD_WORKSPACE_LIMIT)) {
        if (
          !Array.isArray(entry) ||
          !/^[a-f0-9]{64}$/.test(entry[0]) ||
          typeof entry[1] !== 'string'
        )
          continue
        const workspace = hudWorkspacePath(entry[1])
        if (workspace) this.bindings.set(entry[0], workspace)
      }
    } catch {
      /* First run or malformed local history: bind current sessions. */
    }
  }

  project(agents: readonly AgentRuntimeState[]): AgentRuntimeState[] {
    let changed = false
    const live = new Set<string>()
    const projected = agents.map((agent) => {
      const key = hudRowKey(agent)
      live.add(key)
      const path = hudWorkspacePath(agent.workspacePath)
      if (agent.externalSessionId && path && !this.bindings.has(key)) {
        this.bindings.set(key, path)
        changed = true
      }
      const workspacePath = this.bindings.get(key) ?? path
      return workspacePath === agent.workspacePath ? agent : { ...agent, workspacePath }
    })
    // Keep temporarily absent sessions across snapshots/restarts; only evict
    // absent history at the bound, never a live card.
    for (const key of this.bindings.keys()) {
      if (this.bindings.size <= HUD_WORKSPACE_LIMIT) break
      if (!live.has(key)) {
        this.bindings.delete(key)
        changed = true
      }
    }
    if (changed && this.path) {
      try {
        writeFileSync(
          `${this.path}.tmp`,
          JSON.stringify({ version: 1, bindings: [...this.bindings] }) + '\n',
          { encoding: 'utf8', mode: 0o600 },
        )
        renameSync(`${this.path}.tmp`, this.path)
      } catch (error) {
        this.onError(error)
      }
    }
    return projected
  }
}

/** Match the HUD renderer's nested-card coalescing boundary. Generic project
 * containers and profile roots have their own cards, not a read-all subtree.
 */
export function isHudProjectRoot(path: string): boolean {
  const parts = path.toLowerCase().split('/').filter(Boolean)
  if (parts.length <= 1) return false
  const leaf = parts.at(-1)!
  if (
    new Set([
      'users',
      'home',
      'desktop',
      'documents',
      'downloads',
      'pictures',
      'music',
      'videos',
      'onedrive',
      'appdata',
      'temp',
      'tmp',
      'public',
      'library',
      'workspaces',
      'projects',
      'repos',
      'code',
      'dev',
      'src',
    ]).has(leaf)
  )
    return false
  const profile = parts.findIndex((part) => part === 'users' || part === 'home')
  return !(profile >= 0 && parts.length === profile + 2)
}

/**
 * Resolve workspace aliases (symlinks / junctions) before they become hub keys.
 *
 * Hook payloads and disk metadata can describe the same project through different
 * filesystem paths. A small success/failure cache keeps realpath off the hot path
 * during tool-event bursts while still retrying newly-created directories quickly.
 *
 * @module local-server/workspace-path
 */
import { realpath } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AgentEventInput } from '@codepulse/shared'

const SUCCESS_CACHE_MS = 30_000
const FAILURE_CACHE_MS = 1_000
const MAX_CACHE_ENTRIES = 512

interface CachedWorkspacePath {
  expiresAt: number
  value: string
}

/** Configures filesystem access and clock dependencies for a path resolver. */
export interface WorkspacePathResolverOptions {
  /** Supplies the clock used to evaluate cache expiry. */
  now?: () => number
  /** Resolves a filesystem path to its canonical realpath. */
  resolveRealpath?: (path: string) => Promise<string>
}

/**
 * Caches canonical workspace paths for hook and disk-sync ingress.
 *
 * Absolute paths are resolved through realpath. Failures return the original
 * path so missing or inaccessible workspaces still receive stable hub keys;
 * concurrent requests for the same key share one filesystem lookup.
 */
export class WorkspacePathResolver {
  private readonly now: () => number
  private readonly resolveRealpath: (path: string) => Promise<string>
  private readonly cache = new Map<string, CachedWorkspacePath>()
  private readonly pending = new Map<string, Promise<string>>()

  constructor(options: WorkspacePathResolverOptions = {}) {
    this.now = options.now ?? Date.now
    this.resolveRealpath = options.resolveRealpath ?? realpath
  }

  /**
   * Returns the canonical form of an absolute workspace path.
   *
   * Non-absolute paths bypass realpath. Successful lookups use a longer cache
   * TTL than failures, because a missing directory may be created shortly.
   *
   * @param path Candidate workspace path from a hook payload or disk metadata.
   * @returns The resolved realpath, or the original path when it cannot resolve.
   */
  async resolve(path: string): Promise<string> {
    if (!path || !isAbsolute(path)) return path

    const key = workspacePathCacheKey(path)
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.now()) return cached.value
    if (cached) this.cache.delete(key)

    const inFlight = this.pending.get(key)
    if (inFlight) return await inFlight

    const request = Promise.resolve()
      // Promise chaining also converts a synchronously-throwing test adapter into a safe fallback.
      .then(() => this.resolveRealpath(path))
      .then((resolved) => {
        this.remember(key, resolved, SUCCESS_CACHE_MS)
        return resolved
      })
      .catch(() => {
        // Missing/inaccessible paths still remain usable as stable fallback keys.
        this.remember(key, path, FAILURE_CACHE_MS)
        return path
      })
      .finally(() => {
        this.pending.delete(key)
      })
    this.pending.set(key, request)
    return await request
  }

  /** Evicts the oldest insertion when the bounded FIFO cache is full. */
  private remember(key: string, value: string, ttlMs: number): void {
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(key)) {
      const oldest = this.cache.keys().next().value as string | undefined
      if (oldest) this.cache.delete(oldest)
    }
    this.cache.set(key, { value, expiresAt: this.now() + ttlMs })
  }
}

/**
 * Canonicalizes both path-bearing event fields without changing other payload data.
 *
 * @param input Normalized hook input before it is converted to a hub event.
 * @param resolver Shared resolver for this local-server instance.
 * @returns The original input when nothing changes, otherwise a shallow path-updated copy.
 */
export async function resolveEventWorkspacePaths(
  input: AgentEventInput,
  resolver: Pick<WorkspacePathResolver, 'resolve'>,
): Promise<AgentEventInput> {
  const [workspacePath, cwd] = await Promise.all([
    input.workspacePath ? resolver.resolve(input.workspacePath) : undefined,
    input.cwd ? resolver.resolve(input.cwd) : undefined,
  ])

  if (workspacePath === input.workspacePath && cwd === input.cwd) return input
  return { ...input, workspacePath, cwd }
}

/** Produces a platform-aware cache key without changing the original fallback path. */
function workspacePathCacheKey(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

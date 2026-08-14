import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { parseTokenCount } from '@codepulse/shared'

interface CachedModelWindows {
  mtimeMs: number
  size: number
  windows: ReadonlyMap<string, number>
}

interface ResolveCodexModelContextWindowOptions {
  codexHome?: string
  rolloutPath?: string
}

const modelWindowCache = new Map<string, CachedModelWindows>()

/**
 * Resolves the usable context window for an exact Codex model slug.
 *
 * Codex reserves part of a model's advertised window for internal work. The
 * usable value therefore comes from `context_window` multiplied by
 * `effective_context_window_percent`; `max_context_window` is intentionally
 * ignored because it is not the live `/status` denominator.
 *
 * @param model Exact model slug recorded in the rollout, such as `gpt-5.6-sol`.
 * @param options Optional Codex home or rollout path used to locate the cache.
 * @returns Effective context-window size, or `undefined` when no exact entry exists.

 */
export async function resolveCodexModelContextWindow(
  model: string | undefined,
  options: ResolveCodexModelContextWindowOptions = {},
): Promise<number | undefined> {
  if (!model) return undefined
  const codexHome = resolveCodexHome(options)
  const cachePath = join(codexHome, 'models_cache.json')

  try {
    const metadata = await stat(cachePath)
    const cached = modelWindowCache.get(cachePath)
    if (cached && cached.mtimeMs === metadata.mtimeMs && cached.size === metadata.size) {
      return cached.windows.get(model)
    }

    const parsed: unknown = JSON.parse(await readFile(cachePath, 'utf8'))
    const windows = parseModelWindows(parsed)
    modelWindowCache.set(cachePath, {
      mtimeMs: metadata.mtimeMs,
      size: metadata.size,
      windows,
    })
    return windows.get(model)
  } catch {
    return undefined
  }
}

/**
 * Returns the filesystem revision that can change a resolved model window.
 *
 * @param options Optional Codex home or rollout path used to locate the cache.
 * @returns Stable mtime/size revision, or `missing` when unavailable.

 */
export async function codexModelCacheRevision(
  options: ResolveCodexModelContextWindowOptions = {},
): Promise<string> {
  const cachePath = join(resolveCodexHome(options), 'models_cache.json')
  try {
    const metadata = await stat(cachePath)
    return `${metadata.mtimeMs}:${metadata.size}`
  } catch {
    return 'missing'
  }
}

/**
 * Chooses the Codex home for model metadata without guessing from model names.
 *
 * @param options Explicit home and optional rollout location.
 * @returns Directory expected to contain `models_cache.json`.

 */
function resolveCodexHome(options: ResolveCodexModelContextWindowOptions): string {
  if (options.codexHome) return options.codexHome
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME
  return inferCodexHomeFromRollout(options.rolloutPath) ?? join(homedir(), '.codex')
}

/**
 * Infers a custom Codex home from `<home>/sessions/.../rollout.jsonl`.
 *
 * @param rolloutPath Rollout path whose ancestor tree may contain `sessions`.
 * @returns Parent of the `sessions` directory, when present.

 */
function inferCodexHomeFromRollout(rolloutPath: string | undefined): string | undefined {
  if (!rolloutPath) return undefined
  let current = dirname(rolloutPath)
  while (true) {
    if (basename(current).toLowerCase() === 'sessions') return dirname(current)
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Parses exact model-slug windows from Codex's model cache schema.
 *
 * @param value Parsed `models_cache.json` content.
 * @returns Immutable mapping from model slug to effective context window.

 */
function parseModelWindows(value: unknown): ReadonlyMap<string, number> {
  const root = asRecord(value)
  const models = Array.isArray(value) ? value : Array.isArray(root?.models) ? root.models : []
  const windows = new Map<string, number>()

  for (const candidate of models) {
    const record = asRecord(candidate)
    const slug = typeof record?.slug === 'string' ? record.slug : undefined
    const contextWindow = parseTokenCount(record?.context_window)
    const effectivePercent = finiteNumber(record?.effective_context_window_percent)
    if (
      !slug ||
      contextWindow == null ||
      contextWindow <= 0 ||
      effectivePercent == null ||
      effectivePercent <= 0 ||
      effectivePercent > 100
    ) {
      continue
    }
    windows.set(slug, Math.round((contextWindow * effectivePercent) / 100))
  }

  return windows
}

/**
 * Narrows an unknown JSON value to a non-array object.
 *
 * @param value Value to inspect.
 * @returns Object record, or `undefined` for primitives and arrays.

 */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/**
 * Returns a finite numeric value without accepting numeric-like strings.
 *
 * @param value Value to inspect.
 * @returns Finite number, or `undefined`.

 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

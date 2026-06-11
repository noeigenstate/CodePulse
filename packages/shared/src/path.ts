/**
 * Normalize a workspace path for cross-platform comparisons.
 *
 * Windows hooks may report backslashes while Codex rollout metadata often uses
 * forward slashes. CodePulse keeps the display path untouched, but all internal
 * grouping keys must use this normalized form.
 */
export function normalizeWorkspacePath(path: string | undefined): string | undefined {
  return path?.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** Return a stable empty-string-safe key for workspace maps. */
export function workspaceKey(path: string | undefined): string {
  return normalizeWorkspacePath(path) ?? ''
}

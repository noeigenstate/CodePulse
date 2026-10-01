const CLAUDE_FAMILIES = new Set(['opus', 'sonnet', 'haiku', 'fable'])

/**
 * Shows Claude model IDs the way Claude Code's own status line names them.
 *
 * Hook and transcript sources report raw IDs (`claude-opus-5-5`,
 * `claude-sonnet-4-5-20250929`, `claude-3-5-sonnet-20241022`) while the status
 * line reports display names (`Opus 5.5`), so the same model could appear two
 * ways on neighbouring cards. Anything that is not a recognised Claude ID is
 * returned unchanged.
 *
 * @param model Model name or ID as reported by the CLI.
 * @returns Display name for project cards.
 */
export function formatModelName(model: string): string {
  const id = model.trim()
  const context = /\[1m\]$/i.test(id) ? ' (1M)' : ''
  const bare = id.replace(/\[1m\]$/i, '').toLowerCase()

  // Current scheme: claude-<family>-<major>[-<minor>][-<yyyymmdd>]
  const modern = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare)
  if (modern && CLAUDE_FAMILIES.has(modern[1]!)) {
    return `${family(modern[1]!)} ${version(modern[2]!, modern[3])}${context}`
  }

  // Legacy scheme: claude-<major>[-<minor>]-<family>[-<yyyymmdd>]
  const legacy = /^claude-(\d+)(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(bare)
  if (legacy && CLAUDE_FAMILIES.has(legacy[3]!)) {
    return `${family(legacy[3]!)} ${version(legacy[1]!, legacy[2])}${context}`
  }

  return id
}

function family(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function version(major: string, minor: string | undefined): string {
  return minor === undefined ? major : `${major}.${minor}`
}

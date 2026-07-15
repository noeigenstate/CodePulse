/**
 * Privacy boundary for event persistence.
 *
 * Hook payloads may contain prompts, source code, command arguments, environment
 * variables, HTTP headers, and tool results. Only irreversible metadata derived
 * here is allowed to cross into SQLite.
 */

/** Maximum number of user-visible characters persisted for a message preview. */
export const PERSISTED_PREVIEW_MAX = 120

const MAX_FILE_TYPE_HINTS = 12
const FILE_EXTENSION_RE = /\.([a-zA-Z0-9]{1,8})\b/g
const ALLOWED_FILE_EXTENSIONS = new Set([
  'c',
  'cpp',
  'cs',
  'css',
  'go',
  'h',
  'html',
  'ipynb',
  'java',
  'js',
  'json',
  'jsonc',
  'jsx',
  'kt',
  'md',
  'mdx',
  'mjs',
  'py',
  'pyi',
  'rs',
  'rst',
  'scss',
  'toml',
  'ts',
  'tsx',
  'xml',
  'yaml',
  'yml',
])

/** Persist a short, trimmed preview even if an untrusted caller skipped adapter truncation. */
export function toPersistedPreview(text: string | undefined): string | undefined {
  if (!text) return undefined
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.length <= PERSISTED_PREVIEW_MAX) return trimmed
  return `${trimmed.slice(0, PERSISTED_PREVIEW_MAX - 3)}...`
}

/**
 * Reduce a command to an allowlisted set of file extensions.
 *
 * Paths, filenames, arguments, environment values, URLs, and free-form command
 * text are deliberately discarded. The result is sufficient for the existing
 * file-type aggregate and cannot reconstruct the original command.
 */
export function toPersistedFileTypeHints(command: string | null | undefined): string | undefined {
  if (!command) return undefined

  const hints = new Set<string>()
  FILE_EXTENSION_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FILE_EXTENSION_RE.exec(command)) !== null) {
    const extension = match[1]!.toLowerCase()
    if (!ALLOWED_FILE_EXTENSIONS.has(extension)) continue
    hints.add(`.${extension}`)
    if (hints.size >= MAX_FILE_TYPE_HINTS) break
  }

  return hints.size > 0 ? [...hints].join(' ') : undefined
}

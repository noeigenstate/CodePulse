/** Normalize an explicit task name; never derive one from prompts or tool output. */
export function normalizeTaskTitle(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const title = value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return title ? Array.from(title).slice(0, 240).join('') : undefined
}

const AUXILIARY_PROMPT_ENVELOPES = [
  'This is an app-generated request for a suggested next user message. The user did not write this message.',
  '# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:',
  'You are an expert at upholding safety and compliance standards for Codex ambient suggestions.',
] as const

/** Known native provenance only. Unknown sources and user-created forks remain visible. */
export function isCodexAuxiliarySession(
  metadata: Record<string, unknown>,
  prompt?: unknown,
): boolean {
  if (metadata.thread_source === 'user') return false
  if (metadata.thread_source === 'guardian_review') return true
  const source = metadata.source
  if (source && typeof source === 'object') {
    const subagent = (source as Record<string, unknown>).subagent
    if (
      subagent &&
      typeof subagent === 'object' &&
      (subagent as Record<string, unknown>).other === 'guardian'
    )
      return true
  }
  // Older app hooks omit provenance for ephemeral suggestion sessions. Match
  // the exact opening envelope before preview truncation, never generic words
  // such as "review", a task title, or a missing entry in the native index.
  return typeof prompt === 'string' && AUXILIARY_PROMPT_ENVELOPES.some(prefix =>
    prompt.trimStart().replace(/\r\n/g, '\n').startsWith(prefix))
}

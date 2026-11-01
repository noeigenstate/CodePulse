import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeTaskTitle } from '@codepulse/shared'

const MAX_INDEX_BYTES = 4 * 1024 * 1024
const MAX_TITLES = 20_000

/** Read-only native title index, bounded and cached by file revision. Never opens a task. */
export class CodexSessionTitles {
  private readonly path: string
  private revision?: string
  private titles = new Map<string, string>()
  private pending?: Promise<ReadonlyMap<string, string>>

  constructor(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
    this.path = join(codexHome, 'session_index.jsonl')
  }

  read(): Promise<ReadonlyMap<string, string>> {
    if (!this.pending)
      this.pending = this.refresh().finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  private async refresh(): Promise<ReadonlyMap<string, string>> {
    try {
      const info = await stat(this.path)
      const revision = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
      if (revision === this.revision) return this.titles
      const file = await open(this.path, 'r')
      let text: string
      const start = Math.max(0, info.size - MAX_INDEX_BYTES)
      try {
        const buffer = Buffer.alloc(Math.min(info.size, MAX_INDEX_BYTES))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
        text = buffer.subarray(0, bytesRead).toString('utf8')
      } finally {
        await file.close()
      }
      const lines = text.split(/\r?\n/)
      if (start > 0) lines.shift() // May begin halfway through a UTF-8/JSON row.
      const titles = new Map<string, string>()
      for (const line of lines) {
        try {
          const row = JSON.parse(line)
          const title = normalizeTaskTitle(row?.thread_name)
          if (typeof row?.id !== 'string' || !row.id || !title) continue
          // Append-only native index: the last valid record wins after rename.
          titles.delete(row.id)
          titles.set(row.id, title)
          if (titles.size > MAX_TITLES) titles.delete(titles.keys().next().value!)
        } catch {
          /* In-progress or malformed lines are not names. */
        }
      }
      this.titles = titles
      this.revision = revision
    } catch {
      /* Missing/temporarily locked index: keep known names, use workspace fallback. */
    }
    return this.titles
  }
}

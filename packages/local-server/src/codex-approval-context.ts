import { open, realpath, type FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentEvent } from '@codepulse/shared'

const MAX_HEADER_BYTES = 1024 * 1024
const READ_CHUNK_BYTES = 256 * 1024
const MAX_ROW_BYTES = 1024 * 1024
const MAX_SCAN_BYTES = 512 * 1024 * 1024

/** Walk backwards until the current turn, including across large tool/image rows.
 * Memory stays bounded independently of transcript size. Oversized non-metadata
 * rows are skipped only when their top-level type can be positively identified.
 */
async function* reverseRows(file: FileHandle, size: number): AsyncGenerator<string> {
  let end = size
  let carry: Buffer = Buffer.alloc(0)
  let oversized = false
  while (end > 0 && size - end < MAX_SCAN_BYTES) {
    const start = Math.max(0, end - READ_CHUNK_BYTES)
    const chunk = Buffer.alloc(end - start)
    const { bytesRead } = await file.read(chunk, 0, chunk.length, start)
    if (bytesRead !== chunk.length) throw new Error('Transcript changed during read')
    const data = Buffer.concat([chunk, carry])
    let cursor = data.length
    for (;;) {
      const newline = data.lastIndexOf(10, cursor - 1)
      if (newline < 0) break
      const row = data.subarray(newline + 1, cursor)
      if (oversized || row.length > MAX_ROW_BYTES) {
        assertSkippableLargeRow(row)
      } else if (row.length) yield row.toString('utf8')
      oversized = false
      cursor = newline
      if (cursor === 0) break
    }
    const prefix = data.subarray(0, cursor)
    oversized ||= prefix.length > MAX_ROW_BYTES
    // Preserve the leading bytes while discarding the middle of huge rows.
    carry = Buffer.from(oversized ? prefix.subarray(0, 512) : prefix)
    end = start
  }
  if (end > 0) throw new Error('Transcript scan budget exceeded')
  if (oversized) assertSkippableLargeRow(carry)
  else if (carry.length) yield carry.toString('utf8')
}

function assertSkippableLargeRow(prefix: Buffer): void {
  // Native JSONL may include an ordinal between timestamp and type.
  // Do not accidentally classify a nested tool result as outer metadata.
  const type =
    /^\s*\{\s*(?:"timestamp"\s*:\s*"[^"]*"\s*,\s*)?(?:"ordinal"\s*:\s*\d+\s*,\s*)?"type"\s*:\s*"([^"]+)"/.exec(
      prefix.toString('utf8'),
    )?.[1]
  if (type !== 'response_item' && type !== 'session_meta')
    throw new Error('Oversized or unsupported native metadata row')
}
// These are sandbox command/file approvals. Do not infer routing for app-level
// computer-use, arbitrary MCP tools, or requests for user input from this list.
const SANDBOX_TOOLS = new Set([
  'Bash',
  'bash',
  'shell',
  'shell_command',
  'exec_command',
  'apply_patch',
])

/** Read native, per-turn approval routing without trusting hook permission_mode. */
export class CodexApprovalContext {
  private readonly sessions: string

  constructor(codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')) {
    this.sessions = join(codexHome, 'sessions')
  }

  /** Unknown/missing metadata always preserves the normal attention signal. */
  async isAutomaticSandboxApproval(event: AgentEvent): Promise<boolean> {
    if (
      event.source !== 'codex' ||
      event.eventType !== 'permission_request' ||
      !event.externalSessionId ||
      !event.externalTurnId ||
      !event.tokenSourcePath ||
      !isAbsolute(event.tokenSourcePath) ||
      !SANDBOX_TOOLS.has(event.toolName ?? '')
    )
      return false

    try {
      const [root, path] = await Promise.all([
        realpath(this.sessions),
        realpath(event.tokenSourcePath),
      ])
      const child = relative(root, path)
      if (
        !child ||
        child === '..' ||
        child.startsWith(`..${sep}`) ||
        isAbsolute(child) ||
        !child.endsWith('.jsonl')
      )
        return false
      const file = await open(path, 'r')
      try {
        const info = await file.stat()
        if (!info.isFile()) return false
        const header = Buffer.alloc(Math.min(info.size, MAX_HEADER_BYTES))
        const first = await file.read(header, 0, header.length, 0)
        const newline = header.subarray(0, first.bytesRead).indexOf(10)
        if (newline < 0) return false
        const meta = JSON.parse(header.subarray(0, newline).toString('utf8'))
        if (meta?.type !== 'session_meta' || meta.payload?.id !== event.externalSessionId)
          return false

        const ending = Buffer.alloc(1)
        await file.read(ending, 0, 1, info.size - 1)
        if (ending[0] !== 10) return false // Incomplete writer snapshot remains unknown.
        let checkedLatestSettings = false
        for await (const line of reverseRows(file, info.size)) {
          if (!/"type"\s*:\s*"(?:turn_context|thread_settings_applied)"/.test(line)) continue
          const row = JSON.parse(line)
          // The desktop may re-apply settings during a turn. Require the latest
          // such update to agree with the exact turn snapshot; never use a
          // settings-only row to infer another turn's reviewer.
          if (
            row?.type === 'thread_settings_applied' ||
            (row?.type === 'event_msg' && row.payload?.type === 'thread_settings_applied')
          ) {
            if (!checkedLatestSettings) {
              const settings = row.payload?.thread_settings
              if (
                settings?.approvals_reviewer !== 'auto_review' ||
                settings.approval_policy !== 'on-request'
              )
                return false
              checkedLatestSettings = true
            }
            continue
          }
          if (row?.type !== 'turn_context') continue
          // Use only the latest context, never another turn, session, or the
          // global config (different chats may have different approval modes).
          const context = row.payload
          return (
            context?.turn_id === event.externalTurnId &&
            context.approval_policy === 'on-request' &&
            context.approvals_reviewer === 'auto_review'
          )
        }
      } finally {
        await file.close()
      }
    } catch {
      // Missing, locked, malformed or unsupported native metadata: stay visible.
    }
    return false
  }
}

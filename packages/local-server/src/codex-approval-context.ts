import { open, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'
import type { AgentEvent } from '@codepulse/shared'

const MAX_HEADER_BYTES = 1024 * 1024
const MAX_CONTEXT_BYTES = 8 * 1024 * 1024
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

        const start = Math.max(0, info.size - MAX_CONTEXT_BYTES)
        const buffer = Buffer.alloc(Math.min(info.size, MAX_CONTEXT_BYTES))
        const { bytesRead } = await file.read(buffer, 0, buffer.length, start)
        const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n')
        if (start > 0) lines.shift() // Drop a possibly partial UTF-8/JSON row.
        if (lines.at(-1) !== '') return false // Writer has not completed this snapshot.
        let checkedLatestSettings = false
        for (let index = lines.length - 1; index >= 0; index--) {
          const line = lines[index]!
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

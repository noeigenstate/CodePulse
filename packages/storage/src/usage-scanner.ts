/**
 * Builds the usage ledger from the CLIs' own logs, the only source with exact
 * per-request usage:
 *
 * - Claude Code: `~/.claude/projects/**\/*.jsonl` transcripts. Each assistant
 *   API response carries `message.usage`; streaming writes one line per content
 *   block with identical usage, so rows are keyed by message id + request id.
 * - Codex: `~/.codex/sessions/**\/*.jsonl` rollouts. `token_count` events carry
 *   `last_token_usage`; a repeated cumulative total (rate-limit refresh) is skipped.
 * - OpenCode: running totals per session from its database (injected reader).
 *
 * Files are read incrementally from the last complete line, yielding between
 * chunks so a first scan of a large history does not block the event loop.
 *
 * @module storage/usage-scanner
 */
import { open, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type Database from 'better-sqlite3'
import type { AgentType } from '@codepulse/shared'
import { UsageLedgerWriter, type UsageScanFileState } from './usage-ledger.js'

export interface OpencodeTotalsRow {
  sessionId: string
  cwd: string
  model?: string
  updatedAt: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface UsageScannerOptions {
  sqlite: Database.Database
  /** `~/.claude/projects` */
  claudeProjectsDir?: string
  /** `~/.codex/sessions` */
  codexSessionsDir?: string
  /** Reads OpenCode session totals; omitted when OpenCode support is not wired. */
  readOpencodeTotals?: () => OpencodeTotalsRow[]
}

export interface UsageScanResult {
  files: number
  changedFiles: number
  records: number
  prompts: number
  durationMs: number
}

const CHUNK_BYTES = 1 << 20

/** System-injected user lines that are not prompts the person typed. */
const INJECTED_PROMPT =
  /^\s*(<(task-notification|command-name|command-message|command-args|local-command-|system-reminder|bash-input|bash-stdout|bash-stderr|user-memory-input)|\[Request interrupted)/

/** Serialized scanner; concurrent `scan()` calls share the running pass. */
export class UsageScanner {
  private running: Promise<UsageScanResult> | undefined
  private writer: UsageLedgerWriter
  lastScanAt: number | undefined

  constructor(readonly options: UsageScannerOptions) {
    this.writer = new UsageLedgerWriter(options.sqlite)
  }

  scan(): Promise<UsageScanResult> {
    if (!this.running) {
      this.running = this.scanOnce().finally(() => {
        this.running = undefined
      })
    }
    return this.running
  }

  private async scanOnce(): Promise<UsageScanResult> {
    const started = Date.now()
    const result: UsageScanResult = {
      files: 0,
      changedFiles: 0,
      records: 0,
      prompts: 0,
      durationMs: 0,
    }
    const { claudeProjectsDir, codexSessionsDir, readOpencodeTotals } = this.options

    if (claudeProjectsDir) {
      for (const file of await listJsonl(claudeProjectsDir)) {
        await this.scanFile(file, 'claude_code', result)
      }
    }
    if (codexSessionsDir) {
      for (const file of await listJsonl(codexSessionsDir)) {
        await this.scanFile(file, 'codex', result)
      }
    }
    if (readOpencodeTotals) {
      try {
        const rows = readOpencodeTotals()
        this.options.sqlite.transaction(() => {
          for (const row of rows) {
            this.writer.record(
              {
                id: `oc:${row.sessionId}`,
                agentType: 'opencode',
                sessionId: row.sessionId,
                workspacePath: row.cwd || undefined,
                model: row.model,
                timestamp: row.updatedAt,
                input: row.input,
                cacheRead: row.cacheRead,
                cacheWrite5m: row.cacheWrite,
                cacheWrite1h: 0,
                output: row.output,
              },
              true,
            )
            result.records += 1
          }
        })()
      } catch (err) {
        console.warn('[codepulse] usage scan: opencode totals unavailable', err)
      }
    }

    result.durationMs = Date.now() - started
    this.lastScanAt = Date.now()
    return result
  }

  private async scanFile(path: string, agent: AgentType, result: UsageScanResult): Promise<void> {
    result.files += 1
    let info
    try {
      info = await stat(path)
    } catch {
      return
    }
    const saved = this.writer.fileState(path)
    if (
      saved &&
      saved.size === info.size &&
      Math.round(saved.mtimeMs) === Math.round(info.mtimeMs)
    ) {
      return
    }
    // A shorter file was rewritten; start over (row ids make this idempotent).
    const restart = !saved || info.size < saved.offset
    const state: UsageScanFileState = {
      path,
      offset: restart ? 0 : saved.offset,
      size: info.size,
      mtimeMs: info.mtimeMs,
      context: restart ? {} : { ...(saved.context ?? {}) },
    }
    if (state.offset >= info.size) {
      this.writer.saveFileState(state)
      return
    }
    result.changedFiles += 1

    const handle = await open(path, 'r')
    try {
      let position = state.offset
      let carry = ''
      while (position < info.size) {
        const length = Math.min(CHUNK_BYTES, info.size - position)
        const buffer = Buffer.alloc(length)
        const { bytesRead } = await handle.read(buffer, 0, length, position)
        if (bytesRead <= 0) break
        position += bytesRead
        const text = carry + buffer.subarray(0, bytesRead).toString('utf8')
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline < 0) {
          carry = text
          continue
        }
        const complete = text.slice(0, lastNewline)
        carry = text.slice(lastNewline + 1)
        this.options.sqlite.transaction(() => {
          for (const line of complete.split('\n')) {
            if (agent === 'claude_code') this.claudeLine(line, path, result)
            else this.codexLine(line, path, state, result)
          }
        })()
        // Only whole lines count as consumed; a partial tail is re-read next time.
        state.offset = position - Buffer.byteLength(carry, 'utf8')
        this.writer.saveFileState(state)
        await new Promise((resolve) => setImmediate(resolve))
      }
    } finally {
      await handle.close()
    }
  }

  private claudeLine(line: string, path: string, result: UsageScanResult): void {
    const isAssistant = line.includes('"type":"assistant"') && line.includes('"usage"')
    const isUser = !isAssistant && line.includes('"type":"user"')
    // Prompts typed while a turn is running are logged as queued-command attachments.
    const isQueued = !isAssistant && line.includes('"queued_command"')
    if (!isAssistant && !isUser && !isQueued) return
    let row: ClaudeLine
    try {
      row = JSON.parse(line) as ClaudeLine
    } catch {
      return
    }
    const timestamp = Date.parse(row.timestamp ?? '')
    if (!Number.isFinite(timestamp)) return
    const sessionId = row.sessionId ?? basename(path, '.jsonl')

    if (row.type === 'assistant') {
      const message = row.message
      const usage = message?.usage
      if (!message || !usage || !message.model || message.model === '<synthetic>') return
      const creation = usage.cache_creation
      const write1h = creation ? num(creation.ephemeral_1h_input_tokens) : 0
      const write5m = creation
        ? num(creation.ephemeral_5m_input_tokens)
        : num(usage.cache_creation_input_tokens)
      this.writer.record({
        id: `cc:${message.id ?? row.uuid}:${row.requestId ?? ''}`,
        agentType: 'claude_code',
        sessionId,
        workspacePath: row.cwd,
        model: message.model,
        timestamp,
        input: num(usage.input_tokens),
        cacheRead: num(usage.cache_read_input_tokens),
        cacheWrite5m: write5m,
        cacheWrite1h: write1h,
        output: num(usage.output_tokens),
      })
      result.records += 1
      return
    }

    if (row.type === 'attachment') {
      const attachment = row.attachment
      if (
        attachment?.type !== 'queued_command' ||
        attachment.origin?.kind !== 'human' ||
        row.isSidechain
      ) {
        return
      }
      const queued = promptText(attachment.prompt)
      if (queued === undefined || INJECTED_PROMPT.test(queued)) return
      this.writer.prompt({
        id: `ccq:${attachment.source_uuid ?? row.uuid ?? `${sessionId}:${timestamp}`}`,
        agentType: 'claude_code',
        sessionId,
        workspacePath: row.cwd,
        timestamp,
        text: queued,
      })
      result.prompts += 1
      return
    }

    if (row.type !== 'user' || row.isMeta || row.isSidechain || row.toolUseResult) return
    const text = promptText(row.message?.content)
    if (text === undefined || INJECTED_PROMPT.test(text)) return
    this.writer.prompt({
      id: `ccp:${row.uuid ?? `${sessionId}:${timestamp}`}`,
      agentType: 'claude_code',
      sessionId,
      workspacePath: row.cwd,
      timestamp,
      text,
    })
    result.prompts += 1
  }

  private codexLine(
    line: string,
    path: string,
    state: UsageScanFileState,
    result: UsageScanResult,
  ): void {
    const relevant =
      line.includes('"token_count"') ||
      line.includes('"turn_context"') ||
      line.includes('"session_meta"') ||
      line.includes('"role":"user"')
    if (!relevant) return
    let row: CodexLine
    try {
      row = JSON.parse(line) as CodexLine
    } catch {
      return
    }
    const ctx = state.context as CodexContext
    const payload = row.payload ?? {}
    const timestamp = Date.parse(row.timestamp ?? '')
    const sessionId = ctx.sessionId ?? codexSessionId(path)

    if (row.type === 'session_meta') {
      if (typeof payload.id === 'string') ctx.sessionId = payload.id
      if (typeof payload.cwd === 'string') ctx.cwd = payload.cwd
      return
    }
    if (row.type === 'turn_context') {
      if (typeof payload.model === 'string') ctx.model = payload.model
      if (typeof payload.cwd === 'string') ctx.cwd = payload.cwd
      return
    }
    if (!Number.isFinite(timestamp)) return

    // Typed prompts are user-role response items; older rollouts also mirror
    // them as `user_message` events, which are ignored to avoid double counting.
    if (row.type === 'response_item' && payload.type === 'message' && payload.role === 'user') {
      const text = codexPromptText(payload.content)
      if (text === undefined || CODEX_INJECTED_PROMPT.test(text)) return
      this.writer.prompt({
        id: `cxp:${sessionId}:${typeof payload.id === 'string' ? payload.id : row.timestamp}`,
        agentType: 'codex',
        sessionId,
        workspacePath: ctx.cwd,
        model: ctx.model,
        timestamp,
        text,
      })
      result.prompts += 1
      return
    }
    if (row.type !== 'event_msg') return

    if (payload.type === 'token_count') {
      const info = payload.info
      const last = info?.last_token_usage
      const total = num(info?.total_token_usage?.total_tokens)
      if (!last || total <= num(ctx.lastTotal)) return
      ctx.lastTotal = total
      const cached = num(last.cached_input_tokens)
      const write = num(last.cache_write_input_tokens)
      this.writer.record({
        id: `cx:${sessionId}:${total}`,
        agentType: 'codex',
        sessionId,
        workspacePath: ctx.cwd,
        model: ctx.model,
        timestamp,
        // OpenAI reports input including cached and cache-written tokens.
        input: Math.max(0, num(last.input_tokens) - cached - write),
        cacheRead: cached,
        cacheWrite5m: write,
        cacheWrite1h: 0,
        output: num(last.output_tokens),
        reasoning: num(last.reasoning_output_tokens),
      })
      result.records += 1
      return
    }
  }
}

interface ClaudeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

interface ClaudeLine {
  type?: string
  uuid?: string
  sessionId?: string
  requestId?: string
  timestamp?: string
  cwd?: string
  isMeta?: boolean
  isSidechain?: boolean
  toolUseResult?: unknown
  attachment?: {
    type?: string
    prompt?: unknown
    source_uuid?: string
    origin?: { kind?: string }
  }
  message?: { id?: string; model?: string; usage?: ClaudeUsage; content?: unknown }
}

interface CodexTokenUsage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
  reasoning_output_tokens?: number
  total_tokens?: number
}

interface CodexLine {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    id?: unknown
    cwd?: unknown
    model?: unknown
    message?: unknown
    role?: unknown
    content?: unknown
    info?: { total_token_usage?: CodexTokenUsage; last_token_usage?: CodexTokenUsage } | null
  }
}

interface CodexContext {
  sessionId?: string
  cwd?: string
  model?: string
  lastTotal?: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Text of a typed prompt, or `undefined` for tool results and empty messages. */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim() ? content : undefined
  if (!Array.isArray(content)) return undefined
  let text = ''
  let hasImage = false
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === 'tool_result') return undefined
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
    if (block?.type === 'image') hasImage = true
  }
  if (text.trim()) return text
  return hasImage ? '[image]' : undefined
}

/** Context Codex injects as user-role messages (`<environment_context>`, …). */
const CODEX_INJECTED_PROMPT = /^\s*<[a-z_]+[\s>]/i

function codexPromptText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === 'input_text' && typeof block.text === 'string') text += block.text
  }
  return text.trim() ? text : undefined
}

function codexSessionId(path: string): string {
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path)
  return match?.[1] ?? basename(path, '.jsonl')
}

async function listJsonl(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 6) await walk(full, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out.sort()
}

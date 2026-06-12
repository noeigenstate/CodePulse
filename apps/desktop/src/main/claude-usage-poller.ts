/**
 * Claude Code transcript usage poller.
 *
 * Claude statusline only runs while the CLI is actively rendering. This poller
 * reads local transcript JSONL files so the dashboard can refresh token/context
 * snapshots even when no new hook request reaches the local server.
 *
 * @module main/claude-usage-poller
 */
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { normalizeEvent, type StatusHub } from '@codepulse/core'
import { parseTokenCount, type AgentEventInput, type TokenPayload } from '@codepulse/shared'

const TAIL_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_FILES = 300
const MAX_CLAUDE_SNAPSHOTS = 20
const DEFAULT_CLAUDE_CONTEXT_WINDOW =
  parseTokenCount(process.env.CODEPULSE_CLAUDE_CONTEXT_WINDOW) ??
  parseTokenCount(process.env.CODEPULSE_CONTEXT_WINDOW) ??
  200_000
export const CLAUDE_USAGE_POLL_INTERVAL_MS =
  Number(process.env.CODEPULSE_CLAUDE_USAGE_POLL_MS) || 5_000

interface TranscriptFile {
  path: string
  mtimeMs: number
}

interface TranscriptSnapshot {
  externalSessionId?: string
  cwd?: string
  model?: string
  token: TokenPayload
}

/**
 * Start polling Claude local transcript files for context updates.
 *
 * @param hub target status hub.
 * @param intervalMs polling interval in milliseconds.
 * @returns stop function.
 */
export function startClaudeUsagePoller(
  hub: StatusHub,
  intervalMs = CLAUDE_USAGE_POLL_INTERVAL_MS,
): () => void {
  let stopped = false
  const lastSignatures = new Map<string, string>()

  async function poll(): Promise<void> {
    if (stopped) return
    try {
      const inputs = await readRecentClaudeTokenSnapshots()
      for (const input of inputs) {
        if (!input.token) continue
        const key = snapshotKey(input)
        const signature = JSON.stringify({
          session: input.externalSessionId,
          workspace: input.workspacePath ?? input.cwd,
          model: input.model,
          token: input.token,
        })
        if (signature === lastSignatures.get(key)) continue
        lastSignatures.set(key, signature)
        hub.ingest(normalizeEvent(input))
      }
    } catch (err) {
      console.error('[codepulse] failed to poll Claude usage', err)
    }
  }

  const timer = setInterval(() => void poll(), intervalMs)
  timer.unref?.()
  void poll()

  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * Read recent Claude transcript usage records as token_snapshot inputs.
 *
 * @param claudeHome optional CLAUDE_HOME override for tests.
 * @param maxSnapshots maximum number of distinct session/workspace snapshots.
 * @returns token snapshot inputs ordered by transcript mtime descending.
 */
export async function readRecentClaudeTokenSnapshots(
  claudeHome = process.env.CLAUDE_HOME ?? join(homedir(), '.claude'),
  maxSnapshots = MAX_CLAUDE_SNAPSHOTS,
): Promise<AgentEventInput[]> {
  const files: TranscriptFile[] = []
  await collectTranscriptFiles(join(claudeHome, 'projects'), files)
  files.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const events: AgentEventInput[] = []
  const seen = new Set<string>()
  for (const file of files.slice(0, MAX_TRANSCRIPT_FILES)) {
    const snapshot = await readTranscriptSnapshot(file.path)
    if (!snapshot) continue
    const event: AgentEventInput = {
      source: 'claude_code',
      eventType: 'token_snapshot',
      externalSessionId: snapshot.externalSessionId ?? sessionIdFromFile(file.path),
      cwd: snapshot.cwd,
      workspacePath: snapshot.cwd,
      model: snapshot.model,
      token: snapshot.token,
      raw: { source: 'claude_code', channel: 'transcript-poll', file: basename(file.path) },
    }
    const key = snapshotKey(event)
    if (seen.has(key)) continue
    seen.add(key)
    events.push(event)
    if (events.length >= maxSnapshots) break
  }

  return events
}

async function collectTranscriptFiles(dir: string, out: TranscriptFile[]): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of [...entries].sort((a, b) => b.name.localeCompare(a.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectTranscriptFiles(path, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    try {
      const info = await stat(path)
      out.push({ path, mtimeMs: info.mtimeMs })
    } catch {
      // Ignore files that disappear while Claude is writing.
    }
  }
}

async function readTranscriptSnapshot(file: string): Promise<TranscriptSnapshot | undefined> {
  const lines = (await readTail(file)).trim().split(/\r?\n/)
  let fallbackSessionId: string | undefined
  let fallbackCwd: string | undefined
  let fallbackModel: string | undefined

  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseJsonRecord(lines[i])
    if (!record) continue

    fallbackSessionId ??= stringValue(record.sessionId) ?? stringValue(record.session_id)
    fallbackCwd ??= stringValue(record.cwd)
    const message = recordValue(record.message)
    fallbackModel ??= stringValue(message?.model) ?? stringValue(record.model)

    if (record.isSidechain === true) continue

    const usage = recordValue(message?.usage) ?? recordValue(record.usage)
    if (!usage) continue
    const token = tokenFromClaudeUsage(usage)
    if (!token) continue

    return {
      externalSessionId:
        stringValue(record.sessionId) ?? stringValue(record.session_id) ?? fallbackSessionId,
      cwd: stringValue(record.cwd) ?? fallbackCwd,
      model: stringValue(message?.model) ?? stringValue(record.model) ?? fallbackModel,
      token,
    }
  }

  return undefined
}

async function readTail(file: string): Promise<string> {
  const handle = await open(file, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    return buffer.toString('utf8')
  } finally {
    await handle.close()
  }
}

function tokenFromClaudeUsage(usage: Record<string, unknown>): TokenPayload | undefined {
  const inputBase = numberValue(usage.input_tokens)
  const cacheCreation = numberValue(usage.cache_creation_input_tokens)
  const cacheRead = numberValue(usage.cache_read_input_tokens)
  const input = sumKnown(inputBase, cacheCreation, cacheRead)
  const cachedInput = sumKnown(cacheCreation, cacheRead)
  const output = numberValue(usage.output_tokens)
  const total = sumKnown(input, output)
  const contextWindow = DEFAULT_CLAUDE_CONTEXT_WINDOW
  const contextUsedPercent =
    contextWindow && input != null ? Math.min(100, (input / contextWindow) * 100) : undefined

  if (input == null && output == null && total == null) return undefined
  return {
    input,
    cachedInput,
    output,
    total,
    contextUsedPercent,
    contextWindow,
    accuracy: 'estimated',
  }
}

function sumKnown(...values: Array<number | undefined>): number | undefined {
  let found = false
  let total = 0
  for (const value of values) {
    if (value == null) continue
    found = true
    total += value
  }
  return found ? total : undefined
}

function sessionIdFromFile(path: string): string | undefined {
  const name = basename(path)
  return name.endsWith('.jsonl') ? name.slice(0, -'.jsonl'.length) : undefined
}

function snapshotKey(input: AgentEventInput): string {
  return [
    input.source,
    input.externalSessionId ?? '',
    input.workspacePath ?? input.cwd ?? '',
    input.model ?? '',
  ].join('\0')
}

function parseJsonRecord(line: string | undefined): Record<string, unknown> | undefined {
  if (!line?.trim()) return undefined
  try {
    const value: unknown = JSON.parse(line)
    return recordValue(value)
  } catch {
    return undefined
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numberValue(value: unknown): number | undefined {
  return parseTokenCount(value)
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

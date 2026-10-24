import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StatusHub } from '@codepulse/core'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'

const MAX_STATE_BYTES = 4 * 1024 * 1024
const MAX_UNREAD_THREADS = 50_000
interface NativeReadState {
  scope: string
  unread: ReadonlySet<string>
}
interface ResultIdentity {
  turnId: string
  terminalAt: number
}

/** Compatibility reader for the desktop client's persisted local read state.
 * Never reads auth data, opens chats, or writes back to the client. Absence from
 * an unread list is not a read receipt: only a witnessed removal is actionable.
 * Multiple account/local-host scopes are deliberately unsupported rather than
 * guessing which client's "read" should acknowledge the user's result.
 */
export function parseCodexReadState(value: unknown): NativeReadState | undefined {
  const root = record(value)
  const state = record(root?.['electron-thread-read-state-v1'])
  if (state?.version !== 1) return
  const identities = record(state.unreadByIdentity)
  if (!identities || Object.keys(identities).length !== 1) return
  const [identity, hostsValue] = Object.entries(identities)[0]!
  if (!/^[a-f0-9]{64}$/.test(identity)) return
  const hosts = record(hostsValue)
  if (!hosts) return
  const local = Object.entries(hosts).filter(([key]) => key.startsWith('local:'))
  if (local.length !== 1) return
  const [host, ids] = local[0]!
  if (!/^local:[a-f0-9]{64}$/.test(host) || !Array.isArray(ids) || ids.length > MAX_UNREAD_THREADS)
    return
  if (!ids.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256)) return
  return { scope: `${identity}:${host}`, unread: new Set(ids as string[]) }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

async function readNativeState(path: string): Promise<unknown> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > MAX_STATE_BYTES) return
    const bytes = Buffer.alloc(info.size)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== bytes.length) return
    return JSON.parse(bytes.toString('utf8'))
  } finally {
    await file.close()
  }
}

function resultIdentity(row: AgentRuntimeState): ResultIdentity | undefined {
  if (
    row.agentType !== 'codex' ||
    !row.externalSessionId ||
    !row.externalTurnId ||
    !row.unread ||
    !Number.isFinite(row.terminalAt) ||
    row.needPermission ||
    row.needUserInput ||
    ![TurnState.DONE, TurnState.ERROR, TurnState.CANCELLED, TurnState.USAGE_LIMITED].some(
      (state) => row.state === state,
    )
  )
    return
  return { turnId: row.externalTurnId, terminalAt: row.terminalAt! }
}

/** Clears only the same completed result observed both before and after a
 * native unread -> read transition. Running tasks and approvals are untouched.
 * Missing/partial files, logout, identity changes and restarts re-arm a baseline.
 */
export class CodexReadStateSync {
  private readonly read: () => Promise<unknown>
  private readonly intervalMs: number
  private timer?: ReturnType<typeof setInterval>
  private running = false
  private generation = 0
  private pending?: Promise<void>
  private previous?: NativeReadState
  private results = new Map<string, ResultIdentity>()

  constructor(
    private readonly options: {
      hub: StatusHub
      codexHome?: string
      intervalMs?: number
      readState?: () => Promise<unknown>
    },
  ) {
    this.intervalMs = options.intervalMs ?? 1_000
    const path = join(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      '.codex-global-state.json',
    )
    this.read = options.readState ?? (() => readNativeState(path))
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    await this.syncNow()
    if (this.running && this.intervalMs > 0) {
      this.timer = setInterval(() => {
        void this.syncNow()
      }, this.intervalMs)
      this.timer.unref()
    }
  }

  stop(): void {
    this.running = false
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.previous = undefined
    this.results.clear()
  }

  syncNow(): Promise<void> {
    if (!this.running) return Promise.resolve()
    if (!this.pending)
      this.pending = this.sync(this.generation).finally(() => {
        this.pending = undefined
      })
    return this.pending
  }

  private async sync(generation: number): Promise<void> {
    let state: NativeReadState | undefined
    try {
      state = parseCodexReadState(await this.read())
    } catch {
      /* No read evidence. */
    }
    if (!this.running || generation !== this.generation) return
    if (!state) {
      this.previous = undefined
      this.results.clear()
      return
    }
    const rows = this.options.hub.snapshot().agents
    const acknowledged: AgentRuntimeState[] = []
    const nextResults = new Map<string, ResultIdentity>()
    for (const row of rows) {
      const current = resultIdentity(row)
      if (!current) continue
      const session = row.externalSessionId!
      const previous = this.results.get(session)
      if (
        this.previous?.scope === state.scope &&
        this.previous.unread.has(session) &&
        !state.unread.has(session) &&
        previous?.turnId === current.turnId &&
        previous.terminalAt === current.terminalAt
      )
        acknowledged.push(row)
      if (state.unread.has(session)) nextResults.set(session, current)
    }
    this.previous = state
    this.results = nextResults
    // No await between the current snapshot comparison and acknowledgement.
    if (acknowledged.length) this.options.hub.acknowledgeRows(acknowledged)
  }
}

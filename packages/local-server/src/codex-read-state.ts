import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { StatusHub } from '@codepulse/core'
import { TurnState, type AgentRuntimeState } from '@codepulse/shared'
import {
  CodexReadEventObserver,
  type NativeReadEvent,
  type NativeReadEvents,
} from './codex-read-events.js'

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
interface ReadReceipt {
  scope: string
  turnId: string
  receivedAt: number
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
    ![
      TurnState.DONE,
      TurnState.ERROR,
      TurnState.CANCELLED,
      TurnState.USAGE_LIMITED,
      TurnState.TIMEOUT,
    ].some((state) => row.state === state)
  )
    return
  return { turnId: row.externalTurnId, terminalAt: row.terminalAt! }
}

/** Acknowledges a matching terminal turn using an explicit native read event,
 * or a witnessed persisted unread -> read transition. Running work and real
 * approvals are untouched; uncertain identity/read evidence never clears them.
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
  private readonly events?: NativeReadEvents
  private readonly now: () => number
  private receipts = new Map<string, ReadReceipt>()

  constructor(
    private readonly options: {
      hub: StatusHub
      codexHome?: string
      intervalMs?: number
      readState?: () => Promise<unknown>
      readEvents?: NativeReadEvents | false
      now?: () => number
    },
  ) {
    this.intervalMs = options.intervalMs ?? 1_000
    const path = join(
      options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex'),
      '.codex-global-state.json',
    )
    this.read = options.readState ?? (() => readNativeState(path))
    this.now = options.now ?? Date.now
    // Injected state readers/tests never attach to the user's native client.
    this.events =
      options.readEvents === false
        ? undefined
        : (options.readEvents ??
          (options.readState || options.codexHome
            ? undefined
            : new CodexReadEventObserver({
                onConnected: () =>
                  console.info('[CodexReadState] Native read-event observer connected'),
              })))
  }

  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.events?.start(
      (event) => this.onReadEvent(event),
      () => this.receipts.clear(),
    )
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
    this.receipts.clear()
    this.events?.stop()
  }

  private onReadEvent(event: NativeReadEvent): void {
    if (!this.running) return
    this.receipts.delete(event.sessionId)
    if (event.unread) return
    // Bind synchronously, before file I/O. A subsequent turn cannot inherit the
    // receipt. A late session projection can use it only if already terminal at
    // the moment the native client sent the read notification.
    // findSession includes results retained solely for HUD after the ordinary
    // dashboard snapshot has expired them.
    const row = this.options.hub.findSession('codex', event.sessionId)
    if (!row?.externalTurnId || row.needPermission || row.needUserInput) return
    if (this.receipts.size >= 1_000) this.receipts.delete(this.receipts.keys().next().value!)
    this.receipts.set(event.sessionId, {
      scope: event.scope,
      turnId: row.externalTurnId,
      receivedAt: this.now(),
    })
    void this.syncNow()
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
      this.receipts.clear()
      return
    }
    const rows = this.options.hub.snapshotForPresentation().agents
    const acknowledged: AgentRuntimeState[] = []
    const nextResults = new Map<string, ResultIdentity>()
    const now = this.now()
    for (const [session, receipt] of this.receipts) {
      if (
        receipt.scope !== state.scope ||
        now < receipt.receivedAt ||
        now - receipt.receivedAt > 15_000
      )
        this.receipts.delete(session)
    }
    let liveReadCount = 0
    for (const row of rows) {
      const session = row.externalSessionId!
      const receipt = this.receipts.get(session)
      if (
        receipt &&
        (receipt.turnId !== row.externalTurnId || row.needPermission || row.needUserInput)
      )
        this.receipts.delete(session)
      const current = resultIdentity(row)
      if (!current) continue
      const previous = this.results.get(session)
      if (
        this.receipts.has(session) &&
        receipt?.turnId === current.turnId &&
        current.terminalAt <= receipt.receivedAt
      ) {
        acknowledged.push(row)
        this.receipts.delete(session)
        liveReadCount++
      } else if (
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
    if (liveReadCount)
      console.info(`[CodexReadState] Native read acknowledged ${liveReadCount} completed result(s)`)
  }
}

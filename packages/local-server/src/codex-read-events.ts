import { createHash, randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'

export interface NativeReadEvent {
  sessionId: string
  scope: string
  unread: boolean
}

export interface NativeReadEvents {
  start(onRead: (event: NativeReadEvent) => void, onReset: () => void): void
  stop(): void
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** Only the installed client's scoped v3 receipt is evidence of reading. */
export function parseNativeReadEvent(message: unknown): NativeReadEvent | undefined {
  const frame = record(message)
  if (
    frame?.type !== 'broadcast' ||
    frame.method !== 'thread-read-state-changed' ||
    frame.version !== 3
  )
    return
  const params = record(frame.params),
    context = record(params?.context)
  const identity = record(context?.identity)
  if (
    !params ||
    params.hostId !== 'local' ||
    typeof params.conversationId !== 'string' ||
    !params.conversationId.length ||
    params.conversationId.length > 256 ||
    typeof params.hasUnreadTurn !== 'boolean' ||
    typeof context?.executionHostKey !== 'string' ||
    !/^local:[a-f0-9]{64}$/.test(context.executionHostKey) ||
    !identity
  )
    return
  let tuple: string[]
  if (identity.kind === 'chatgpt') {
    if (typeof identity.accountId !== 'string' || typeof identity.userId !== 'string') return
    tuple = ['chatgpt', identity.accountId, identity.userId]
  } else {
    // Other identity schemas need explicit verification before enabling them.
    return
  }
  if (tuple.some((value) => !value.length || value.length > 512)) return
  const hash = createHash('sha256').update(JSON.stringify(tuple)).digest('hex')
  return {
    sessionId: params.conversationId,
    scope: `${hash}:${context.executionHostKey}`,
    unread: params.hasUnreadTurn,
  }
}

const MAX_RETAINED_FRAME = 64 * 1024
const MAX_WIRE_FRAME = 256 * 1024 * 1024

/** Bounded frame reader. Large unrelated task payloads are skipped in place. */
export class NativeReadFrames {
  private header = Buffer.alloc(4)
  private headerBytes = 0
  private length = 0
  private offset = 0
  private body?: Buffer

  constructor(private readonly onMessage: (message: unknown) => void) {}

  push(chunk: Buffer): void {
    let index = 0
    while (index < chunk.length) {
      if (!this.length) {
        const count = Math.min(4 - this.headerBytes, chunk.length - index)
        chunk.copy(this.header, this.headerBytes, index, index + count)
        this.headerBytes += count
        index += count
        if (this.headerBytes < 4) return
        this.length = this.header.readUInt32LE()
        this.headerBytes = 0
        if (!this.length || this.length > MAX_WIRE_FRAME)
          throw new Error('Invalid native IPC frame length')
        this.body = this.length <= MAX_RETAINED_FRAME ? Buffer.alloc(this.length) : undefined
      }
      const count = Math.min(this.length - this.offset, chunk.length - index)
      this.body?.set(chunk.subarray(index, index + count), this.offset)
      this.offset += count
      index += count
      if (this.offset !== this.length) continue
      const body = this.body
      this.length = this.offset = 0
      this.body = undefined
      if (body) this.onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}

/** Passive client of an ALREADY running native router. It never starts a
 * server, owns a thread, sends application requests, or publishes broadcasts.
 * Discovery is explicitly rejected so other clients' requests never wait on us.
 */
export class CodexReadEventObserver implements NativeReadEvents {
  private socket?: Socket
  private retry?: ReturnType<typeof setTimeout>
  private handshake?: ReturnType<typeof setTimeout>
  private running = false
  private retryMs = 1_000
  private onRead?: (event: NativeReadEvent) => void
  private onReset?: () => void

  constructor(
    private readonly options: {
      endpoint?: string
      reconnectMs?: number
      onConnected?: () => void
    } = {},
  ) {}

  start(onRead: (event: NativeReadEvent) => void, onReset: () => void): void {
    if (this.running || (!this.options.endpoint && process.platform !== 'win32')) return
    this.running = true
    this.onRead = onRead
    this.onReset = onReset
    this.connect()
  }

  stop(): void {
    this.running = false
    if (this.retry) clearTimeout(this.retry)
    if (this.handshake) clearTimeout(this.handshake)
    this.retry = this.handshake = undefined
    const socket = this.socket
    this.socket = undefined
    socket?.destroy()
    this.onRead = this.onReset = undefined
  }

  private connect(): void {
    if (!this.running) return
    const socket = createConnection(this.options.endpoint ?? '\\\\.\\pipe\\codex-ipc')
    this.socket = socket
    socket.unref()
    const requestId = randomUUID()
    let clientId: string | undefined
    const send = (message: unknown) => {
      if (socket.destroyed) return
      if (socket.writableLength > MAX_RETAINED_FRAME) {
        socket.destroy()
        return
      }
      const body = Buffer.from(JSON.stringify(message))
      const frame = Buffer.alloc(4 + body.length)
      frame.writeUInt32LE(body.length)
      body.copy(frame, 4)
      socket.write(frame)
    }
    const frames = new NativeReadFrames((message) => {
      if (!this.running || this.socket !== socket) return
      const frame = record(message)
      if (!frame) return
      if (frame.type === 'client-discovery-request' && typeof frame.requestId === 'string') {
        send({
          type: 'client-discovery-response',
          requestId: frame.requestId,
          response: { canHandle: false },
        })
      } else if (frame.type === 'request' && typeof frame.requestId === 'string') {
        send({
          type: 'response',
          requestId: frame.requestId,
          resultType: 'error',
          error: 'no-handler-for-request',
        })
      } else if (frame.type === 'response' && frame.requestId === requestId) {
        const result = record(frame.result)
        if (
          frame.resultType !== 'success' ||
          frame.method !== 'initialize' ||
          typeof result?.clientId !== 'string'
        ) {
          socket.destroy()
          return
        }
        clientId = result.clientId
        if (this.handshake) clearTimeout(this.handshake)
        this.handshake = undefined
        this.retryMs = 1_000
        this.options.onConnected?.()
      } else if (clientId) {
        if (
          frame.targetClientIds !== undefined &&
          (!Array.isArray(frame.targetClientIds) || !frame.targetClientIds.includes(clientId))
        )
          return
        const event = parseNativeReadEvent(frame)
        if (event) this.onRead?.(event)
      }
    })
    this.handshake = setTimeout(() => socket.destroy(), 5_000)
    this.handshake.unref()
    socket.on('connect', () =>
      send({
        type: 'request',
        requestId,
        sourceClientId: 'initializing-client',
        version: 0,
        method: 'initialize',
        params: { clientType: 'codepulse-read-observer' },
      }),
    )
    socket.on('data', (chunk) => {
      try {
        frames.push(chunk)
      } catch {
        socket.destroy()
      }
    })
    socket.on('error', () => {
      /* File polling remains available. */
    })
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.handshake) clearTimeout(this.handshake)
      this.handshake = undefined
      this.onReset?.()
      if (!this.running) return
      this.retry = setTimeout(() => this.connect(), this.options.reconnectMs ?? this.retryMs)
      this.retry.unref()
      this.retryMs = Math.min(this.retryMs * 2, 30_000)
    })
  }
}

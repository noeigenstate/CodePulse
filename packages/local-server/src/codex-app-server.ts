/**
 * Reads Codex account quota through the CLI's read-only App Server protocol.
 *
 * The client deliberately exposes no thread or turn methods. It keeps one
 * JSONL stdio process alive, coalesces concurrent refreshes, and converts only
 * account metadata and rate-limit snapshots into sanitized CodePulse values.
 *
 * @module local-server/codex-app-server

 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { join, win32 as win32Path } from 'node:path'
import type { TokenPayload, TokenQuotaBucket, TokenRateLimitWindow } from '@codepulse/shared'
import { buildAugmentedPath, commandCandidates } from './agent-detect.js'

const DEFAULT_BURST_DELAYS_MS = [0, 180, 500] as const
/** Lower quota is accepted globally only after five compatible physical reads. */
const LOWER_QUOTA_CONFIRMATION_READS = 5
/** Extra reads stay close together after the normal three-read burst detects a reset. */
const LOWER_QUOTA_EXTRA_DELAY_MS = 180
/** Minimum window capacity retained for the common five-hour plus weekly pair. */
const MIN_LOWER_QUOTA_WINDOW_CAPACITY = 2
/** Maximum window multiplier needed for main, Spark, and future native quota families. */
const MAX_LOWER_QUOTA_WINDOW_CAPACITY = 6
/** Absolute physical-read cap for one refresh worker burst. */
const MAX_LOWER_QUOTA_BURST_ATTEMPTS = 32
const DEFAULT_POLL_INTERVAL_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000
const DEFAULT_RESTART_DELAY_MS = 1_000
const MAX_RESTART_DELAY_MS = 60_000
const MAX_STDOUT_BUFFER_CHARS = 1_048_576
const ACCOUNT_SCOPE_SECRET = randomBytes(32)
const CLIENT_INFO = { name: 'codepulse', title: 'CodePulse', version: '1.3.3' } as const

type JsonRecord = Record<string, unknown>

/** Minimal writable stream surface required by the App Server client. */
export interface CodexAppServerWritable {
  /**
   * Writes one UTF-8 JSONL frame.
   *
   * @param chunk Serialized JSONL frame.
   * @returns Whether the stream can accept more data immediately.

   */
  write(chunk: string): boolean
  /** Ends the input stream during graceful shutdown. */
  end(): void
}

/** Minimal readable stream surface required by the App Server client. */
export interface CodexAppServerReadable {
  /**
   * Registers a stream listener.
   *
   * @param event Stream event to observe.
   * @param listener Callback invoked for the event.
   * @returns This readable stream.

   */
  on(event: 'data' | 'error', listener: (...args: unknown[]) => void): this
  /**
   * Drains an ignored stream, when supported.
   *
   * @returns This readable stream.

   */
  resume?(): this
}

/** Injectable child-process surface used by production and unit tests. */
export interface CodexAppServerChild {
  /** Operating-system process identifier, when the child has been spawned. */
  readonly pid?: number
  stdin: CodexAppServerWritable
  stdout: CodexAppServerReadable
  stderr?: CodexAppServerReadable
  /**
   * Registers a child lifecycle listener.
   *
   * @param event Child-process event to observe.
   * @param listener Callback invoked for the event.
   * @returns This child process.

   */
  on(event: 'error' | 'exit', listener: (...args: unknown[]) => void): this
  /**
   * Terminates the child during restart or shutdown.
   *
   * @param signal Optional termination signal.
   * @returns Whether the signal was delivered.

   */
  kill(signal?: NodeJS.Signals): boolean
}

/** Safe spawn settings passed to an injected App Server process factory. */
export interface CodexAppServerSpawnOptions {
  env: NodeJS.ProcessEnv
  stdio: ['pipe', 'pipe', 'pipe']
  windowsHide: boolean
  /** Preserves the pre-quoted trusted `cmd.exe /c` command on Windows. */
  windowsVerbatimArguments?: boolean
  shell: false
}

/**
 * Factory for a Codex App Server child process.
 *
 * @param command Resolved executable or trusted system wrapper.
 * @param args Arguments that launch `codex app-server --stdio`.
 * @param options Restricted environment and pipe-only spawn settings.
 * @returns Spawned child-process adapter.

 */
export type CodexAppServerSpawn = (
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions,
) => CodexAppServerChild

/** Resolved executable and arguments for a Codex App Server process. */
export interface CodexAppServerCommand {
  command: string
  args: string[]
}

/** Sanitized quota result emitted by {@link CodexAppServerQuotaService}. */
export interface CodexAppServerQuotaSnapshot {
  /** Normalized CodePulse quota payload. */
  token: TokenPayload
  /** Process-local, non-reversible account discriminator. */
  accountScope: string
  /** Epoch milliseconds when this snapshot was observed. */
  updatedAt: number
  /** Protocol path that produced this snapshot. */
  source: 'read' | 'notification'
}

/** Configuration and test seams for {@link CodexAppServerQuotaService}. */
export interface CodexAppServerQuotaServiceOptions {
  /** Receives sanitized reads and rolling quota notifications. */
  onSnapshot: (snapshot: CodexAppServerQuotaSnapshot) => void
  /** Receives the process-local account scope after every successful account read. */
  onAccountScope?: (scope: string) => void
  /** CLI environment; defaults to the current process environment. */
  env?: NodeJS.ProcessEnv
  /** Target platform; injectable for command-resolution tests. */
  platform?: NodeJS.Platform
  /** Child-process factory; tests should provide an in-memory fake. */
  spawnProcess?: CodexAppServerSpawn
  /** Delays before each rate-limit read in one refresh burst. */
  burstDelaysMs?: readonly number[]
  /** Interval between lightweight single reads; zero disables polling. */
  pollIntervalMs?: number
  /** Maximum duration of one protocol request. */
  requestTimeoutMs?: number
  /** Delay before reconnecting after a child failure. */
  restartDelayMs?: number
  /** Clock used for snapshot timestamps. */
  now?: () => number
  /** Test seam for a non-secret `auth.json` filesystem revision. */
  credentialRevisionReader?: () => Promise<string | undefined>
}

interface PendingRequest {
  /** App Server RPC method used for response-specific synchronization. */
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/** Physical-read confirmation state for one quota family and rolling window. */
interface PendingLowerQuotaWindow {
  /** Number of compatible physical reads observed for this window. */
  count: number
  /** Most recent lower reading used to enforce non-decreasing confirmation. */
  lastWindow: TokenRateLimitWindow
}

/** Result of binding one opaque-account quota response to a credential revision. */
type OpaqueCredentialValidation = 'accepted' | 'unverified' | 'changed' | 'stale'

/**
 * Maintains a read-only Codex App Server connection for accurate account quota.
 *
 * Calling {@link refresh} performs the equivalent of several `/status` quota
 * reads without writing to, prompting, or otherwise disturbing a live session.

 */
export class CodexAppServerQuotaService {
  private readonly onSnapshot: (snapshot: CodexAppServerQuotaSnapshot) => void
  private readonly onAccountScope?: (scope: string) => void
  private readonly env: NodeJS.ProcessEnv
  private readonly platform: NodeJS.Platform
  private readonly spawnProcess: CodexAppServerSpawn
  private readonly burstDelaysMs: readonly number[]
  private readonly pollIntervalMs: number
  private readonly requestTimeoutMs: number
  private readonly restartDelayMs: number
  private readonly now: () => number
  private readonly credentialRevisionReader: () => Promise<string | undefined>
  private readonly pending = new Map<number, PendingRequest>()
  private child?: CodexAppServerChild
  private connectPromise?: Promise<void>
  private refreshWorker?: Promise<CodexAppServerQuotaSnapshot | undefined>
  private burstRefreshRequested = false
  private singleRefreshRequested = false
  private pollTimer?: NodeJS.Timeout
  private restartTimer?: NodeJS.Timeout
  private restartAttempt = 0
  private nextRequestId = 1
  private stdoutBuffer = ''
  private running = false
  /** Invalidates asynchronous work that belongs to an earlier start/stop lifetime. */
  private lifecycleGeneration = 0
  private accountBaseScope?: string
  private pendingBoundaryScope?: string
  private accountBoundary = 0
  private accountVerified = false
  private hadVerifiedAccount = false
  private opaqueCredentialRevision?: string
  private accountScope?: string
  private accountGeneration = 0
  private lastSnapshot?: CodexAppServerQuotaSnapshot
  private lowerQuotaConfirmationPending = false
  private lowerQuotaBaseline?: TokenPayload
  /** Independent lower-reset confirmations keyed by quota family and window. */
  private readonly lowerQuotaWindows = new Map<string, PendingLowerQuotaWindow>()
  /** Coalesces notification hints into at most one bounded trailing burst. */
  private lowerHintTrailingQueued = false
  /** Monotonic revision incremented for every rate-limit push notification. */
  private quotaNotificationRevision = 0
  /** Notification revision captured when the latest physical quota response arrived. */
  private lastQuotaResponseNotificationRevision = 0
  private readonly firstEmissionWaiters = new Set<() => void>()

  /**
   * Creates a quota service without starting a child process.
   *
   * @param options Lifecycle, timing, callback, and test-seam configuration.

   */
  constructor(options: CodexAppServerQuotaServiceOptions) {
    this.onSnapshot = options.onSnapshot
    this.onAccountScope = options.onAccountScope
    this.platform = options.platform ?? process.platform
    const providedEnv = options.env ?? {}
    const env = { ...process.env, ...providedEnv }
    const configuredPath =
      findEnvironmentValue(providedEnv, 'PATH') ?? findEnvironmentValue(process.env, 'PATH')
    if (configuredPath !== undefined) env.PATH = configuredPath
    const augmentedPath = buildAugmentedPath(homedir(), env, this.platform)
    if (this.platform === 'win32') {
      for (const key of Object.keys(env)) {
        if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key]
      }
    }
    this.env = {
      ...env,
      PATH: augmentedPath,
    }
    this.spawnProcess = options.spawnProcess ?? spawnCodexAppServer
    this.burstDelaysMs = options.burstDelaysMs ?? DEFAULT_BURST_DELAYS_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS
    this.now = options.now ?? Date.now
    this.credentialRevisionReader =
      options.credentialRevisionReader ?? (() => readCodexCredentialRevision(this.env))
  }

  /**
   * Returns the process identifier of the currently connected App Server child.
   *
   * The identifier is exposed only so process discovery can exclude CodePulse's
   * own background child from interactive Codex CLI liveness checks.
   *
   * @returns Current child PID, or `undefined` while disconnected.

   */
  getProcessId(): number | undefined {
    return this.child?.pid
  }

  /**
   * Starts the connection, performs an initial burst, and enables polling.
   *
   * @returns A promise that settles after the initial refresh attempt.

   */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.lifecycleGeneration += 1
    this.startPolling()
    let markReady: (() => void) | undefined
    const firstEmission = new Promise<void>((resolve) => {
      markReady = resolve
      this.firstEmissionWaiters.add(resolve)
    })
    const refresh = this.refresh()
    await Promise.race([firstEmission, refresh.then(() => undefined)])
    if (markReady) this.firstEmissionWaiters.delete(markReady)
  }

  /** Stops timers, rejects pending requests, and terminates the child. */
  stop(): void {
    this.running = false
    this.lifecycleGeneration += 1
    this.burstRefreshRequested = false
    this.singleRefreshRequested = false
    this.lowerHintTrailingQueued = false
    // A later start must not join a worker that belongs to the stopped lifetime.
    this.refreshWorker = undefined
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.pollTimer = undefined
    this.restartTimer = undefined
    this.disconnect(new Error('Codex App Server stopped'))
  }

  /**
   * Reads account identity once and rate limits several times in a short burst.
   *
   * Concurrent calls share the same burst. Every successful response is
   * emitted immediately so the first read is fast and later reads can catch up.
   *
   * @returns The newest successful snapshot in the completed burst.

   */
  refresh(): Promise<CodexAppServerQuotaSnapshot | undefined> {
    if (!this.running) return Promise.resolve(undefined)
    this.burstRefreshRequested = true
    return this.ensureRefreshWorker()
  }

  /**
   * Starts one serialized worker for burst and lightweight refresh requests.
   *
   * @returns The newest snapshot produced while draining queued work.

   */
  private ensureRefreshWorker(): Promise<CodexAppServerQuotaSnapshot | undefined> {
    if (this.refreshWorker) return this.refreshWorker
    const lifecycleGeneration = this.lifecycleGeneration
    // Defer flag consumption by one microtask so same-turn callers coalesce,
    // while calls arriving during an awaited protocol read remain trailing work.
    const worker = Promise.resolve()
      .then(() => this.runRefreshQueue(lifecycleGeneration))
      .finally(() => {
        if (this.refreshWorker === worker) {
          this.refreshWorker = undefined
          this.lowerHintTrailingQueued = false
        }
      })
    this.refreshWorker = worker
    return worker
  }

  /**
   * Drains refresh requests serially and retains one trailing request per kind.
   *
   * @param lifecycleGeneration Service lifetime that owns this worker.
   * @returns The newest snapshot produced by the drained requests.

   */
  private async runRefreshQueue(
    lifecycleGeneration: number,
  ): Promise<CodexAppServerQuotaSnapshot | undefined> {
    let latest: CodexAppServerQuotaSnapshot | undefined
    while (
      this.isCurrentLifecycle(lifecycleGeneration) &&
      (this.burstRefreshRequested || this.singleRefreshRequested)
    ) {
      const runBurst = this.burstRefreshRequested
      this.burstRefreshRequested = false
      this.singleRefreshRequested = false
      const snapshot = runBurst
        ? await this.performRefresh(lifecycleGeneration)
        : await this.performRefreshOnce(lifecycleGeneration)
      latest = snapshot ?? latest
    }
    return latest
  }

  /**
   * Performs one coalesced account and quota refresh.
   *
   * @param lifecycleGeneration Service lifetime that scheduled this burst.
   * @returns The newest successful snapshot in the burst.

   */
  private async performRefresh(
    lifecycleGeneration: number,
  ): Promise<CodexAppServerQuotaSnapshot | undefined> {
    let accountScope: string
    let accountGeneration: number
    let opaqueAccount = false
    let credentialRevision: string | undefined
    let expectedCredentialRevision: string | undefined
    let requireVerifiedCredentialRevision = false
    try {
      await this.ensureConnected()
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      const generationAtReadStart = this.accountGeneration
      const hadVerifiedAccountAtReadStart = this.hadVerifiedAccount
      const knownCredentialRevisionAtReadStart = this.opaqueCredentialRevision
      const boundaryAlreadyAdvanced = this.pendingBoundaryScope !== undefined
      const accountResponse = asRecord(await this.request('account/read', { refreshToken: false }))
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      if (generationAtReadStart !== this.accountGeneration) {
        this.burstRefreshRequested = true
        return undefined
      }
      const account = accountResponse?.account
      opaqueAccount = isOpaqueCodexAccount(account)
      credentialRevision = opaqueAccount
        ? await this.credentialRevisionReader().catch(() => undefined)
        : undefined
      expectedCredentialRevision = boundaryAlreadyAdvanced
        ? credentialRevision
        : (credentialRevision ?? knownCredentialRevisionAtReadStart)
      requireVerifiedCredentialRevision = hadVerifiedAccountAtReadStart
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      if (generationAtReadStart !== this.accountGeneration) {
        this.burstRefreshRequested = true
        return undefined
      }
      if (
        this.hadVerifiedAccount &&
        opaqueAccount &&
        this.opaqueCredentialRevision !== undefined &&
        credentialRevision !== undefined &&
        this.opaqueCredentialRevision !== credentialRevision &&
        !this.pendingBoundaryScope
      ) {
        this.advanceAccountBoundary()
      }
      const adopted = this.adoptAccountScope(createCodexAccountScope(account))
      this.accountVerified = true
      this.hadVerifiedAccount = true
      if (opaqueAccount && credentialRevision !== undefined) {
        this.opaqueCredentialRevision = credentialRevision
      } else if (!opaqueAccount) {
        this.opaqueCredentialRevision = undefined
      }
      accountScope = adopted.scope
      accountGeneration = adopted.generation
    } catch {
      if (this.isCurrentLifecycle(lifecycleGeneration)) this.scheduleRestart()
      return undefined
    }

    let latest: CodexAppServerQuotaSnapshot | undefined
    const delays = this.burstDelaysMs.length > 0 ? this.burstDelaysMs : [0]
    const normalAttemptLimit = Math.min(delays.length, MAX_LOWER_QUOTA_BURST_ATTEMPTS)
    let attempt = 0
    while (
      attempt < normalAttemptLimit ||
      (hasUnconfirmedLowerQuota(this.lowerQuotaWindows) &&
        attempt < lowerQuotaAttemptLimit(normalAttemptLimit, this.lowerQuotaWindows.size))
    ) {
      const delayMs = delays[attempt] ?? LOWER_QUOTA_EXTRA_DELAY_MS
      attempt += 1
      if (delayMs > 0) await delay(delayMs)
      if (
        !this.isCurrentLifecycle(lifecycleGeneration) ||
        accountGeneration !== this.accountGeneration
      ) {
        break
      }
      try {
        await this.ensureConnected()
        if (!this.isCurrentLifecycle(lifecycleGeneration)) break
        const response = await this.request('account/rateLimits/read')
        if (!this.isCurrentLifecycle(lifecycleGeneration)) break
        if (opaqueAccount) {
          const validation = await this.validateOpaqueCredentialAfterQuotaRead(
            lifecycleGeneration,
            accountGeneration,
            expectedCredentialRevision,
            requireVerifiedCredentialRevision,
          )
          if (validation === 'stale') break
          if (validation === 'changed') return latest
          if (validation === 'unverified') continue
        }
        const normalized = normalizeCodexRateLimitsResponse(response, this.now())
        if (!normalized) continue
        if (accountGeneration !== this.accountGeneration) break
        const snapshot: CodexAppServerQuotaSnapshot = {
          token: normalized,
          accountScope,
          updatedAt: this.now(),
          source: 'read',
        }
        latest = snapshot
        this.emit(snapshot)
      } catch {
        // Keep trying the remaining burst reads; one transient miss must not
        // defeat the deliberate repeated-read refresh strategy.
        if (!this.isCurrentLifecycle(lifecycleGeneration)) return latest
        this.scheduleRestart()
        if (!this.child && accountGeneration === this.accountGeneration) {
          this.burstRefreshRequested = false
          this.singleRefreshRequested = false
          break
        }
      }
    }
    if (
      !this.isCurrentLifecycle(lifecycleGeneration) ||
      accountGeneration !== this.accountGeneration
    ) {
      return latest
    }
    const confirmationComplete =
      this.lowerQuotaWindows.size > 0 && !hasUnconfirmedLowerQuota(this.lowerQuotaWindows)
    const baselineRestored = this.lowerQuotaConfirmationPending && this.lowerQuotaWindows.size === 0
    if (confirmationComplete) {
      const trailingHint =
        this.quotaNotificationRevision > this.lastQuotaResponseNotificationRevision
      this.lowerQuotaConfirmationPending = false
      this.lowerQuotaBaseline = undefined
      this.lowerQuotaWindows.clear()
      if (trailingHint && !this.lowerHintTrailingQueued) {
        this.lowerHintTrailingQueued = true
        this.burstRefreshRequested = true
      }
    } else if (baselineRestored) {
      if (
        this.quotaNotificationRevision > this.lastQuotaResponseNotificationRevision &&
        !this.lowerHintTrailingQueued
      ) {
        this.lowerHintTrailingQueued = true
        this.burstRefreshRequested = true
      } else {
        this.lowerQuotaConfirmationPending = false
        this.lowerQuotaBaseline = undefined
        this.lowerQuotaWindows.clear()
      }
    }
    return latest
  }

  /**
   * Connects and completes the required initialize/initialized handshake.
   *
   * @returns A promise that settles after the connection is ready.

   */
  private ensureConnected(): Promise<void> {
    if (this.connectPromise) return this.connectPromise
    if (this.child) return Promise.resolve()

    const connect = this.connect().finally(() => {
      if (this.connectPromise === connect) this.connectPromise = undefined
    })
    this.connectPromise = connect
    return connect
  }

  /**
   * Spawns one child and initializes the protocol.
   *
   * @returns A promise that settles after protocol initialization.


   * @throws If connect cannot be completed.
  */
  private async connect(): Promise<void> {
    const lifecycleGeneration = this.lifecycleGeneration
    const resolved = await this.resolveCommand()
    if (!this.isCurrentLifecycle(lifecycleGeneration)) return
    const child = this.spawnProcess(resolved.command, resolved.args, {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments:
        this.platform === 'win32' && resolved.command.toLowerCase().endsWith('\\cmd.exe'),
      shell: false,
    })
    if (!this.isCurrentLifecycle(lifecycleGeneration)) {
      closeCodexChild(child)
      return
    }
    this.child = child
    this.stdoutBuffer = ''
    const decoder = new StringDecoder('utf8')
    child.stdout.on(
      'data',

      (chunk) => {
        if (!this.running || this.child !== child) return
        const bytes =
          typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array)
        this.consumeStdout(decoder.write(bytes))
      },
    )
    child.stdout.on(
      'error',

      () => this.handleChildFailure(child),
    )
    child.stderr?.resume?.()
    child.stderr?.on(
      'error',

      () => undefined,
    )
    child.on(
      'error',

      () => this.handleChildFailure(child),
    )
    child.on(
      'exit',

      () => this.handleChildFailure(child),
    )

    try {
      await this.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: { experimentalApi: false, requestAttestation: false },
      })
      if (!this.isCurrentLifecycle(lifecycleGeneration) || this.child !== child) {
        if (this.child !== child) closeCodexChild(child)
        return
      }
      this.write({ method: 'initialized' })
    } catch (error) {
      if (this.child === child) {
        this.disconnect(new Error('Codex App Server initialization failed'))
      } else {
        closeCodexChild(child)
      }
      throw error
    }
  }

  /**
   * Resolves Codex from common GUI-invisible locations before using bare PATH.
   *
   * @returns Executable and arguments for a read-only App Server child.

   */
  private async resolveCommand(): Promise<CodexAppServerCommand> {
    if (this.env['CODEX_CLI_PATH'] || this.platform === 'win32') {
      return resolveCodexAppServerCommand(this.env, this.platform)
    }
    const candidates = await commandCandidates('codex', {
      env: this.env,
      homeDir: homedir(),
      platform: this.platform,
    })
    for (const candidate of candidates) {
      if (!candidate.startsWith('/')) continue
      try {
        await access(candidate, fsConstants.X_OK)
        return resolveCodexAppServerCommand(
          { ...this.env, CODEX_CLI_PATH: candidate },
          this.platform,
        )
      } catch {
        // Continue through Homebrew, nvm, npm-global, and other fixed candidates.
      }
    }
    return resolveCodexAppServerCommand(this.env, this.platform)
  }

  /**
   * Sends one JSONL request and resolves its matching response.
   *
   * @param method App Server method name.
   * @param params Optional method parameters.
   * @returns The raw result from the matching response.

   */
  private request(method: string, params?: unknown): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Codex App Server is unavailable'))
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex App Server request timed out'))
        if (this.child === child) {
          this.disconnect(new Error('Codex App Server request timed out'))
        }
      }, this.requestTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) })
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('Codex App Server request could not be written'))
        if (this.child === child) {
          this.disconnect(new Error('Codex App Server request could not be written'))
        }
      }
    })
  }

  /**
   * Serializes one protocol frame without logging payloads.
   *
   * @param message Protocol frame to write.


   * @throws If write cannot be completed.
  */
  private write(message: JsonRecord): void {
    if (!this.child) throw new Error('Codex App Server is unavailable')
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Buffers arbitrary stdout chunks and handles complete JSONL frames.
   *
   * @param text Decoded stdout fragment.

   */
  private consumeStdout(text: string): void {
    this.stdoutBuffer += text
    if (!this.stdoutBuffer.includes('\n') && this.stdoutBuffer.length > MAX_STDOUT_BUFFER_CHARS) {
      this.stdoutBuffer = ''
      return
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) return
      const line = this.stdoutBuffer.slice(0, newline).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line) continue
      try {
        this.handleMessage(JSON.parse(line) as unknown)
      } catch {
        // Ignore non-protocol diagnostics without echoing potentially sensitive data.
      }
    }
  }

  /**
   * Routes one response, notification, or unsupported server request.
   *
   * @param value Parsed JSONL message.

   */
  private handleMessage(value: unknown): void {
    const message = asRecord(value)
    if (!message) return
    const requestId = requestIdValue(message.id)
    const responseId = typeof requestId === 'number' ? requestId : undefined
    if (responseId != null && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(responseId)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(responseId)
      if (pending.method === 'account/rateLimits/read' && 'result' in message) {
        this.lastQuotaResponseNotificationRevision = this.quotaNotificationRevision
      }
      if ('error' in message) pending.reject(new Error('Codex App Server request failed'))
      else pending.resolve(message.result)
      return
    }

    if (message.method === 'account/rateLimits/updated') {
      this.quotaNotificationRevision += 1
      this.handleRateLimitsUpdated(message.params)
      return
    }

    if (message.method === 'account/updated') {
      this.handleAccountUpdated()
      return
    }

    // This client never opts into prompts, approvals, tools, or auth-token callbacks.
    if (requestId != null && typeof message.method === 'string') {
      this.write({
        id: requestId,
        error: { code: -32601, message: 'Unsupported read-only client method' },
      })
    }
  }

  /**
   * Merges a sparse rolling quota update into the latest full read.
   *
   * @param params Raw notification parameters.

   */
  private handleRateLimitsUpdated(params: unknown): void {
    if (!this.running || !this.accountVerified || !this.accountScope) {
      if (this.running) void this.refresh()
      return
    }
    const record = asRecord(params)
    const incoming = normalizeCodexRateLimitSnapshot(record?.rateLimits, this.now())
    if (!incoming) return
    const token = mergeQuotaUpdate(this.lastSnapshot?.token, incoming, this.now())
    if (this.lowerQuotaConfirmationPending) {
      // Notifications are hints, not independent reads. Once a reset is being
      // confirmed, clamp their lower windows to the physical-read baseline.
      // Unrelated increases in the same notification remain immediately visible.
      let baseline = this.lowerQuotaBaseline ?? this.lastSnapshot?.token
      if (baseline && this.lastSnapshot) {
        baseline = extendLowerQuotaBaseline(baseline, this.lastSnapshot.token, token)
        this.lowerQuotaBaseline = baseline
      }
      if (baseline) rememberLowerQuotaHints(this.lowerQuotaWindows, token, baseline)
      const safeToken = baseline ? retainPreviousLowerQuota(token, baseline) : token
      if (!baseline || hasHigherQuotaReading(safeToken, baseline)) {
        this.emit({
          token: safeToken,
          accountScope: this.accountScope,
          updatedAt: this.now(),
          source: 'notification',
        })
      }
      if (this.refreshWorker) {
        // The response handler records notification ordering. The active
        // worker queues one trailing burst only if no later physical response
        // has already covered this hint.
      } else {
        void this.refresh()
      }
      return
    }
    if (this.lastSnapshot && hasLowerQuotaReading(token, this.lastSnapshot.token)) {
      // A notification is a hint, not one of the five independent reads used
      // to confirm a reset. Clamp only its lower windows so unrelated increases
      // in the same frame remain immediate, then start a full read burst.
      this.lowerQuotaConfirmationPending = true
      this.lowerQuotaBaseline = this.lastSnapshot.token
      rememberLowerQuotaHints(this.lowerQuotaWindows, token, this.lastSnapshot.token)
      this.emit({
        token: retainPreviousLowerQuota(token, this.lastSnapshot.token),
        accountScope: this.accountScope,
        updatedAt: this.now(),
        source: 'notification',
      })
      if (!this.refreshWorker) void this.refresh()
      return
    }
    this.emit({
      token,
      accountScope: this.accountScope,
      updatedAt: this.now(),
      source: 'notification',
    })
    void this.refreshOnce()
  }

  /** Treats an auth update as an account boundary and schedules a fresh burst. */
  private handleAccountUpdated(): void {
    if (!this.running) return
    this.advanceAccountBoundary()
    void this.refresh()
  }

  /**
   * Invalidates in-flight quota and emits one opaque provisional account scope.
   *
   * The provisional scope lets Hub clear old quota even when the subsequent
   * account read fails or the App Server omits API-key identity.

   */
  private advanceAccountBoundary(): void {
    this.accountBoundary += 1
    this.accountGeneration += 1
    this.accountVerified = false
    this.lastSnapshot = undefined
    this.lowerQuotaConfirmationPending = false
    this.lowerQuotaBaseline = undefined
    this.lowerQuotaWindows.clear()
    this.lowerHintTrailingQueued = false
    const baseScope = this.accountBaseScope ?? createCodexAccountScope(undefined)
    const boundaryScope = createBoundedAccountScope(baseScope, this.accountBoundary)
    this.pendingBoundaryScope = boundaryScope
    this.accountScope = boundaryScope
    this.emitAccountScope(boundaryScope)
  }

  /**
   * Publishes a sanitized snapshot and remembers it for sparse updates.
   *
   * @param snapshot Sanitized account quota snapshot.

   */
  private emit(snapshot: CodexAppServerQuotaSnapshot): void {
    this.markConnectionHealthy()
    const previous = this.lastSnapshot
    if (snapshot.source === 'read') {
      if (previous && this.lowerQuotaConfirmationPending && this.lowerQuotaBaseline) {
        this.lowerQuotaBaseline = extendLowerQuotaBaseline(
          this.lowerQuotaBaseline,
          previous.token,
          snapshot.token,
        )
      }
      if (previous && hasLowerQuotaReading(snapshot.token, previous.token)) {
        this.lowerQuotaConfirmationPending = true
        this.lowerQuotaBaseline ??= previous.token
      }
      if (this.lowerQuotaConfirmationPending && this.lowerQuotaBaseline) {
        observeLowerQuotaWindows(this.lowerQuotaWindows, snapshot.token, this.lowerQuotaBaseline)
      }
    }
    // Keep omitted windows for later sparse notifications, but publish the raw
    // physical read so an omitted lower window cannot count as another sample.
    this.lastSnapshot = {
      ...snapshot,
      token: mergeQuotaPayload(previous?.token, snapshot.token),
    }
    for (const resolve of this.firstEmissionWaiters) resolve()
    this.firstEmissionWaiters.clear()
    try {
      this.onSnapshot(snapshot)
    } catch {
      // Consumer errors must not tear down the protocol reader.
    }
  }

  /** Starts steady quota polling when configured. */
  private startPolling(): void {
    if (this.pollIntervalMs <= 0 || this.pollTimer) return
    this.pollTimer = setInterval(() => void this.refreshOnce(), this.pollIntervalMs)
    this.pollTimer.unref?.()
  }

  /**
   * Performs one lightweight full read after a notification or poll tick.
   *
   * @returns The snapshot produced by the lightweight read.

   */
  private refreshOnce(): Promise<CodexAppServerQuotaSnapshot | undefined> {
    if (!this.running) return Promise.resolve(undefined)
    this.singleRefreshRequested = true
    return this.ensureRefreshWorker()
  }

  /**
   * Waits for any burst, then performs one account and quota read.
   *
   * @param lifecycleGeneration Service lifetime that scheduled this read.
   * @returns The successfully normalized snapshot, if available.

   */
  private async performRefreshOnce(
    lifecycleGeneration: number,
  ): Promise<CodexAppServerQuotaSnapshot | undefined> {
    try {
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      await this.ensureConnected()
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      const generationAtReadStart = this.accountGeneration
      const hadVerifiedAccountAtReadStart = this.hadVerifiedAccount
      const knownCredentialRevisionAtReadStart = this.opaqueCredentialRevision
      const boundaryAlreadyAdvanced = this.pendingBoundaryScope !== undefined
      const accountResponse = asRecord(await this.request('account/read', { refreshToken: false }))
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      if (generationAtReadStart !== this.accountGeneration) {
        this.burstRefreshRequested = true
        return undefined
      }
      const account = accountResponse?.account
      const opaqueAccount = isOpaqueCodexAccount(account)
      const credentialRevision = opaqueAccount
        ? await this.credentialRevisionReader().catch(() => undefined)
        : undefined
      const expectedCredentialRevision = boundaryAlreadyAdvanced
        ? credentialRevision
        : (credentialRevision ?? knownCredentialRevisionAtReadStart)
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      if (generationAtReadStart !== this.accountGeneration) {
        this.burstRefreshRequested = true
        return undefined
      }
      if (
        this.hadVerifiedAccount &&
        opaqueAccount &&
        this.opaqueCredentialRevision !== undefined &&
        credentialRevision !== undefined &&
        this.opaqueCredentialRevision !== credentialRevision &&
        !this.pendingBoundaryScope
      ) {
        this.advanceAccountBoundary()
      }
      const adopted = this.adoptAccountScope(createCodexAccountScope(account))
      this.accountVerified = true
      this.hadVerifiedAccount = true
      if (opaqueAccount && credentialRevision !== undefined) {
        this.opaqueCredentialRevision = credentialRevision
      } else if (!opaqueAccount) {
        this.opaqueCredentialRevision = undefined
      }
      const quotaResponse = await this.request('account/rateLimits/read')
      if (!this.isCurrentLifecycle(lifecycleGeneration)) return undefined
      if (opaqueAccount) {
        const validation = await this.validateOpaqueCredentialAfterQuotaRead(
          lifecycleGeneration,
          adopted.generation,
          expectedCredentialRevision,
          hadVerifiedAccountAtReadStart,
        )
        if (validation !== 'accepted') return undefined
      }
      const token = normalizeCodexRateLimitsResponse(quotaResponse, this.now())
      if (
        !this.isCurrentLifecycle(lifecycleGeneration) ||
        !token ||
        adopted.generation !== this.accountGeneration
      ) {
        return undefined
      }
      const snapshot: CodexAppServerQuotaSnapshot = {
        token,
        accountScope: adopted.scope,
        updatedAt: this.now(),
        source: 'read',
      }
      this.emit(snapshot)
      if (this.lowerQuotaConfirmationPending) this.burstRefreshRequested = true
      return snapshot
    } catch {
      if (this.isCurrentLifecycle(lifecycleGeneration)) this.scheduleRestart()
      return undefined
    }
  }

  /**
   * Verifies that an opaque-account quota response belongs to the adopted scope.
   *
   * A previously verified revision remains the comparison baseline when the
   * pre-request filesystem read is temporarily unavailable. A changed revision
   * advances the account boundary and queues a clean burst; an unavailable
   * post-response revision merely suppresses the ambiguous response.
   *
   * @param lifecycleGeneration Service lifetime that owns the quota response.
   * @param accountGeneration Adopted account generation that issued the request.
   * @param expectedRevision Best verified revision from before the quota request.
   * @param requireRevision Whether an earlier account was already verified.
   * @returns Whether the caller may publish, retry, or abandon the response.
   */
  private async validateOpaqueCredentialAfterQuotaRead(
    lifecycleGeneration: number,
    accountGeneration: number,
    expectedRevision: string | undefined,
    requireRevision: boolean,
  ): Promise<OpaqueCredentialValidation> {
    const revisionAfterRead = await this.credentialRevisionReader().catch(() => undefined)
    if (
      !this.isCurrentLifecycle(lifecycleGeneration) ||
      accountGeneration !== this.accountGeneration
    ) {
      return 'stale'
    }
    if (revisionAfterRead === undefined) {
      return requireRevision ? 'unverified' : 'accepted'
    }
    if (expectedRevision !== undefined && revisionAfterRead !== expectedRevision) {
      this.advanceAccountBoundary()
      this.burstRefreshRequested = true
      return 'changed'
    }
    this.opaqueCredentialRevision = revisionAfterRead
    return 'accepted'
  }

  /**
   * Publishes only the process-local digest produced from account metadata.
   *
   * @param scope Process-local account discriminator.

   */
  private emitAccountScope(scope: string): void {
    try {
      this.onAccountScope?.(scope)
    } catch {
      // Consumer errors must not interrupt quota synchronization.
    }
  }

  /**
   * Adopts an authenticated account without carrying sparse quota across it.
   *
   * @param scope Process-local digest derived from the latest account response.
   * @returns Adopted scope and its account generation.

   */
  private adoptAccountScope(scope: string): { scope: string; generation: number } {
    const boundedScope =
      this.pendingBoundaryScope ??
      (this.accountBaseScope === scope && this.accountScope
        ? this.accountScope
        : createBoundedAccountScope(scope, this.accountBoundary))
    this.pendingBoundaryScope = undefined
    this.accountBaseScope = scope
    if (this.accountScope !== boundedScope) {
      this.lastSnapshot = undefined
      this.lowerQuotaConfirmationPending = false
      this.lowerQuotaBaseline = undefined
      this.lowerQuotaWindows.clear()
      this.lowerHintTrailingQueued = false
    }
    this.accountScope = boundedScope
    this.accountGeneration += 1
    this.emitAccountScope(boundedScope)
    return { scope: boundedScope, generation: this.accountGeneration }
  }

  /**
   * Handles one child failure exactly once and schedules recovery.
   *
   * @param child Child that reported the failure.

   */
  private handleChildFailure(child: CodexAppServerChild): void {
    if (this.child !== child) return
    this.disconnect(new Error('Codex App Server exited'))
    this.scheduleRestart()
  }

  /**
   * Rejects pending work and discards the current child.
   *
   * @param error Error propagated to all pending requests.

   */
  private disconnect(error: Error): void {
    const child = this.child
    this.child = undefined
    this.connectPromise = undefined
    this.accountVerified = false
    this.stdoutBuffer = ''
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    for (const resolve of this.firstEmissionWaiters) resolve()
    this.firstEmissionWaiters.clear()
    if (!child) return
    try {
      child.stdin.end()
    } catch {
      // The input stream may already be closed after a child failure.
    }
    try {
      child.kill()
    } catch {
      // A child may already have exited between the failure event and cleanup.
    }
  }

  /** Schedules one reconnect attempt while the service remains active. */
  private scheduleRestart(): void {
    if (!this.running || this.restartTimer) return
    const delayMs = Math.min(
      MAX_RESTART_DELAY_MS,
      this.restartDelayMs * 2 ** Math.min(this.restartAttempt, 10),
    )
    this.restartAttempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.refresh()
    }, delayMs)
    this.restartTimer.unref?.()
  }

  /** Clears pending retries and returns reconnect delay to its initial value. */
  private markConnectionHealthy(): void {
    this.restartAttempt = 0
    if (!this.restartTimer) return
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
  }

  /**
   * Reports whether asynchronous work still belongs to the active service lifetime.
   *
   * @param generation Lifecycle generation captured before an await boundary.
   * @returns Whether the service is running in the captured generation.

   */
  private isCurrentLifecycle(generation: number): boolean {
    return this.running && generation === this.lifecycleGeneration
  }
}

/**
 * Resolves a direct executable or a trusted Windows wrapper invocation.
 *
 * Windows batch shims run through the system `cmd.exe`, never an arbitrary
 * `ComSpec`. PowerShell shims likewise use the system Windows PowerShell path.
 *
 * @param env Environment containing optional CLI and Windows root overrides.
 * @param platform Platform whose executable rules should be applied.
 * @returns A direct executable plus arguments suitable for `shell: false`.


 * @throws If resolve codex app server command cannot be completed.
*/
export function resolveCodexAppServerCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CodexAppServerCommand {
  const configured = env['CODEX_CLI_PATH']?.trim()
  const cli = configured || (platform === 'win32' ? 'codex.cmd' : 'codex')
  if (/[\r\n\0]/.test(cli)) throw new Error('Invalid CODEX_CLI_PATH')
  if (platform !== 'win32') return { command: cli, args: ['app-server', '--stdio'] }

  const extension = win32Path.extname(cli).toLowerCase()
  const systemRoot = env['SystemRoot'] || env['SYSTEMROOT'] || 'C:\\Windows'
  if (extension === '.ps1') {
    return {
      command: win32Path.join(
        systemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        cli,
        'app-server',
        '--stdio',
      ],
    }
  }
  if (extension === '.cmd' || extension === '.bat' || (!extension && !win32Path.isAbsolute(cli))) {
    if (/["&|<>^%!]/.test(cli)) throw new Error('Unsafe Windows Codex shim path')
    const invocation = `"${cli}" app-server --stdio`
    return {
      command: win32Path.join(systemRoot, 'System32', 'cmd.exe'),
      args: ['/d', '/s', '/c', `"${invocation}"`],
    }
  }
  return { command: cli, args: ['app-server', '--stdio'] }
}

/**
 * Converts an App Server `account/rateLimits/read` result into CodePulse quota.
 *
 * @param payload Raw result object returned by the App Server.
 * @param updatedAt Epoch milliseconds attached to normalized quota buckets.
 * @returns A sanitized token payload, or `undefined` for an incompatible result.

 */
export function normalizeCodexRateLimitsResponse(
  payload: unknown,
  updatedAt = Date.now(),
): TokenPayload | undefined {
  const response = asRecord(payload)
  const main = normalizeCodexRateLimitSnapshot(response?.rateLimits, updatedAt)
  const rawBuckets = asRecord(response?.rateLimitsByLimitId)
  const quotaBuckets: Record<string, TokenQuotaBucket> = {}

  if (rawBuckets) {
    for (const [key, value] of Object.entries(rawBuckets)) {
      const normalized = normalizeCodexRateLimitSnapshot(value, updatedAt)
      if (!normalized?.rateLimits) continue
      const id = normalized.rateLimitId || key
      quotaBuckets[id] = {
        rateLimitId: id,
        ...(normalized.rateLimitName ? { rateLimitName: normalized.rateLimitName } : {}),
        rateLimits: normalized.rateLimits,
        updatedAt,
      }
    }
  }

  const fallback = main ?? Object.values(quotaBuckets)[0]
  if (!fallback?.rateLimits && Object.keys(quotaBuckets).length === 0) return undefined
  return {
    ...(fallback?.rateLimits ? { rateLimits: fallback.rateLimits } : {}),
    ...(Object.keys(quotaBuckets).length > 0 ? { quotaBuckets } : {}),
    ...(fallback?.rateLimitId ? { rateLimitId: fallback.rateLimitId } : {}),
    ...(fallback?.rateLimitName ? { rateLimitName: fallback.rateLimitName } : {}),
    accuracy: 'exact',
  }
}

/**
 * Creates a process-local account scope without exposing raw account metadata.
 *
 * The HMAC key is random for each CodePulse process. Equal account objects are
 * stable during that process, while emails cannot be recovered or correlated
 * across restarts.
 *
 * @param account Raw `account/read` account metadata.
 * @returns A process-local HMAC digest safe for state partitioning.

 */
export function createCodexAccountScope(account: unknown): string {
  const record = asRecord(account)
  const type = stringValue(record?.type) ?? 'none'
  const email = stringValue(record?.email)?.trim().toLowerCase() ?? ''
  const plan = stringValue(record?.planType) ?? ''
  const managed = booleanValue(record?.usesCodexManagedCredentials)
  const identity = JSON.stringify([type, email, plan, managed ?? null])
  return `codex:${createHmac('sha256', ACCOUNT_SCOPE_SECRET).update(identity).digest('base64url').slice(0, 24)}`
}

/**
 * Reports whether App Server omits a stable discriminator for this account.
 *
 * @param account Raw account metadata from `account/read`.
 * @returns `true` for API-key identities that cannot distinguish two keys.

 */
function isOpaqueCodexAccount(account: unknown): boolean {
  const record = asRecord(account)
  return stringValue(record?.type)?.toLowerCase() === 'apikey' && !stringValue(record?.email)
}

/**
 * Reads only the credential file revision, never credential contents.
 *
 * API-key account metadata contains no stable identity. A changed filesystem
 * revision is therefore the privacy-preserving evidence needed to distinguish
 * an offline key replacement from an ordinary App Server crash/reconnect.
 *
 * @param env Process environment containing an optional custom Codex home.
 * @returns Stable mtime/size revision, or `undefined` when the file is unavailable.

 */
async function readCodexCredentialRevision(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const codexHome = env['CODEX_HOME']?.trim() || join(homedir(), '.codex')
  try {
    const metadata = await stat(join(codexHome, 'auth.json'))
    return `${metadata.mtimeMs}:${metadata.size}`
  } catch {
    return undefined
  }
}

/**
 * Derives a new opaque scope after an explicit account-update boundary.
 *
 * App Server intentionally omits API-key identity from `account/read`. Folding
 * the notification epoch into another HMAC lets CodePulse invalidate old quota
 * without reading, retaining, or exposing credential material.
 *
 * @param baseScope Process-local digest for the opaque account metadata.
 * @param boundary Monotonic account-boundary counter.
 * @returns A scope unique to the boundary within this process.

 */
function createBoundedAccountScope(baseScope: string, boundary: number): string {
  if (boundary === 0) return baseScope
  const digest = createHmac('sha256', ACCOUNT_SCOPE_SECRET)
    .update(`${baseScope}\0${boundary}`)
    .digest('base64url')
    .slice(0, 24)
  return `codex:${digest}`
}

/**
 * Finds an environment variable with Windows-compatible key casing.
 *
 * @param env Environment to inspect.
 * @param expectedKey Canonical variable name.
 * @returns The matching environment value, if present.

 */
function findEnvironmentValue(env: NodeJS.ProcessEnv, expectedKey: string): string | undefined {
  const direct = env[expectedKey]
  if (direct !== undefined) return direct
  const normalizedKey = expectedKey.toLowerCase()
  return Object.entries(env).find(([key]) => key.toLowerCase() === normalizedKey)?.[1]
}

/**
 * Spawns the production Codex child using only pipe-based stdio.
 *
 * @param command Executable path or trusted system wrapper.
 * @param args App Server command arguments.
 * @param options Safe child-process options.
 * @returns The spawned child-process adapter.

 */
function spawnCodexAppServer(
  command: string,
  args: readonly string[],
  options: CodexAppServerSpawnOptions,
): CodexAppServerChild {
  return nodeSpawn(command, [...args], options) as unknown as CodexAppServerChild
}

/**
 * Closes a child that became stale before it could be adopted by the service.
 *
 * @param child Unadopted App Server child process.

 */
function closeCodexChild(child: CodexAppServerChild): void {
  try {
    child.stdin.end()
  } catch {
    // The child may have already closed its input during startup failure.
  }
  try {
    child.kill()
  } catch {
    // The child may have exited between the lifecycle check and cleanup.
  }
}

/**
 * Normalizes one single-bucket rate-limit snapshot.
 *
 * @param payload Raw App Server bucket.
 * @param updatedAt Epoch milliseconds assigned to the bucket.
 * @returns A normalized bucket, if the payload contains quota metadata.

 */
function normalizeCodexRateLimitSnapshot(
  payload: unknown,
  updatedAt: number,
): TokenQuotaBucket | undefined {
  const snapshot = asRecord(payload)
  if (!snapshot) return undefined
  const primary = normalizeWindow(snapshot.primary)
  const secondary = normalizeWindow(snapshot.secondary)
  const rateLimits = classifyWindows(primary, secondary)
  const rateLimitId = stringValue(snapshot.limitId)
  const rateLimitName = stringValue(snapshot.limitName)
  if (!rateLimits && !rateLimitId && !rateLimitName) return undefined
  return {
    ...(rateLimitId ? { rateLimitId } : {}),
    ...(rateLimitName ? { rateLimitName } : {}),
    ...(rateLimits ? { rateLimits } : {}),
    updatedAt,
  }
}

/**
 * Maps App Server primary/secondary windows by their declared duration.
 *
 * @param primary First normalized App Server window.
 * @param secondary Second normalized App Server window.
 * @returns CodePulse five-hour and weekly window mapping.

 */
function classifyWindows(
  primary: TokenRateLimitWindow | undefined,
  secondary: TokenRateLimitWindow | undefined,
): TokenPayload['rateLimits'] {
  const windows = [primary, secondary].filter(
    (value): value is TokenRateLimitWindow => value !== undefined,
  )
  if (windows.length === 0) return undefined
  let fiveHour: TokenRateLimitWindow | undefined
  let sevenDay: TokenRateLimitWindow | undefined
  for (const window of windows) {
    const minutes = window.windowMinutes
    if (minutes != null && minutes > 24 * 60) sevenDay ??= window
    else if (minutes != null && minutes > 0) fiveHour ??= window
  }
  if (!fiveHour && !sevenDay) {
    if (primary && secondary) return { fiveHour: primary, sevenDay: secondary }
    return { sevenDay: primary ?? secondary }
  }
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

/**
 * Validates and clamps one App Server quota window.
 *
 * @param payload Raw App Server window.
 * @returns A normalized quota window, if usable metadata exists.

 */
function normalizeWindow(payload: unknown): TokenRateLimitWindow | undefined {
  const window = asRecord(payload)
  if (!window) return undefined
  const usedPercent = numberValue(window.usedPercent)
  const windowMinutes = numberValue(window.windowDurationMins)
  const resetsAt = epochSeconds(window.resetsAt)
  if (usedPercent == null && windowMinutes == null && resetsAt == null) return undefined
  return {
    ...(usedPercent != null ? { usedPercent: Math.min(100, Math.max(0, usedPercent)) } : {}),
    ...(resetsAt != null ? { resetsAt } : {}),
    ...(windowMinutes != null ? { windowMinutes } : {}),
  }
}

/**
 * Detects a lower official quota window relative to the pre-burst snapshot.
 *
 * @param incoming Newly normalized App Server quota.
 * @param previous Last quota emitted before the refresh burst began.
 * @returns `true` when any matching five-hour or weekly window decreased.

 */
function hasLowerQuotaReading(incoming: TokenPayload, previous: TokenPayload): boolean {
  const previousUsage = quotaUsageByWindow(previous)
  for (const [key, usedPercent] of quotaUsageByWindow(incoming)) {
    const accepted = previousUsage.get(key)
    if (accepted !== undefined && usedPercent < accepted) return true
  }
  return false
}

/**
 * Detects an immediately safe quota increase relative to an accepted snapshot.
 *
 * @param incoming Newly normalized App Server quota.
 * @param previous Accepted quota snapshot used as the monotonic baseline.
 * @returns Whether any matching rolling window increased.

 */
function hasHigherQuotaReading(incoming: TokenPayload, previous: TokenPayload): boolean {
  const previousUsage = quotaUsageByWindow(previous)
  for (const [key, usedPercent] of quotaUsageByWindow(incoming)) {
    const accepted = previousUsage.get(key)
    if (accepted === undefined || usedPercent > accepted) return true
  }
  return false
}

/**
 * Applies one physical read to independent lower-reset confirmation windows.
 *
 * Sparse reads update only windows they contain. A present value at or above
 * the baseline explicitly restores that window, while a missing window keeps
 * its existing streak. Lower observations advance only when their period is
 * compatible and usage does not decrease further.
 *
 * @param pending Mutable confirmation state keyed by quota family and window.
 * @param incoming Newly normalized physical App Server read.
 * @param baseline Accepted quota snapshot that established the reset floor.
 */
function observeLowerQuotaWindows(
  pending: Map<string, PendingLowerQuotaWindow>,
  incoming: TokenPayload,
  baseline: TokenPayload,
): void {
  const baselineWindows = quotaWindowsByKey(baseline)
  for (const [key, incomingWindow] of quotaWindowsByKey(incoming)) {
    const baselineUsage = baselineWindows.get(key)?.usedPercent
    const incomingUsage = incomingWindow.usedPercent
    if (
      baselineUsage === undefined ||
      incomingUsage === undefined ||
      !Number.isFinite(baselineUsage) ||
      !Number.isFinite(incomingUsage)
    ) {
      continue
    }
    if (incomingUsage >= baselineUsage) {
      pending.delete(key)
      continue
    }

    const previous = pending.get(key)
    const continues =
      previous !== undefined &&
      previous.lastWindow.usedPercent !== undefined &&
      incomingUsage >= previous.lastWindow.usedPercent &&
      sameQuotaPeriod(previous.lastWindow, incomingWindow)
    pending.set(key, {
      count: continues ? Math.min(LOWER_QUOTA_CONFIRMATION_READS, previous.count + 1) : 1,
      lastWindow: incomingWindow,
    })
  }
}

/**
 * Registers lower notification windows without counting a physical read.
 *
 * Existing physical streaks are left untouched so push notifications can
 * neither advance nor reset them. A newly hinted window starts at zero and
 * remains pending across sparse reads until a physical response includes it.
 *
 * @param pending Mutable confirmation state keyed by quota family and window.
 * @param incoming Quota payload carried by a push notification.
 * @param baseline Accepted quota snapshot used as the monotonic floor.
 */
function rememberLowerQuotaHints(
  pending: Map<string, PendingLowerQuotaWindow>,
  incoming: TokenPayload,
  baseline: TokenPayload,
): void {
  const baselineWindows = quotaWindowsByKey(baseline)
  for (const [key, incomingWindow] of quotaWindowsByKey(incoming)) {
    if (pending.has(key)) continue
    const baselineUsage = baselineWindows.get(key)?.usedPercent
    const incomingUsage = incomingWindow.usedPercent
    if (
      baselineUsage === undefined ||
      incomingUsage === undefined ||
      !Number.isFinite(baselineUsage) ||
      !Number.isFinite(incomingUsage) ||
      incomingUsage >= baselineUsage
    ) {
      continue
    }
    pending.set(key, { count: 0, lastWindow: incomingWindow })
  }
}

/**
 * Reports whether any observed lower window still needs physical confirmation.
 *
 * @param pending Per-window lower-reset confirmation state.
 * @returns Whether at least one window has fewer than five compatible reads.
 */
function hasUnconfirmedLowerQuota(pending: ReadonlyMap<string, PendingLowerQuotaWindow>): boolean {
  for (const state of pending.values()) {
    if (state.count < LOWER_QUOTA_CONFIRMATION_READS) return true
  }
  return false
}

/**
 * Calculates a bounded read budget from the number of pending quota windows.
 *
 * The limit is recalculated on each loop condition because a sparse response
 * may reveal another lower family after the burst has started. Two windows are
 * reserved for the ordinary five-hour/weekly pair, while the absolute cap
 * prevents malformed or adversarial bucket sets from creating an open loop.
 *
 * @param normalAttempts Number of configured reads in the ordinary burst.
 * @param pendingWindowCount Number of independently tracked lower windows.
 * @returns Maximum physical reads allowed in the current burst.
 */
function lowerQuotaAttemptLimit(normalAttempts: number, pendingWindowCount: number): number {
  const confirmationWindowCount = Math.max(
    MIN_LOWER_QUOTA_WINDOW_CAPACITY,
    Math.min(MAX_LOWER_QUOTA_WINDOW_CAPACITY, pendingWindowCount),
  )
  return Math.min(
    MAX_LOWER_QUOTA_BURST_ATTEMPTS,
    normalAttempts + LOWER_QUOTA_CONFIRMATION_READS * confirmationWindowCount,
  )
}

/**
 * Adds newly discovered quota windows to a frozen lower-reset baseline.
 *
 * Only windows present in both the previous accepted snapshot and the current
 * observation are eligible. Existing baseline values are never overwritten,
 * so a lower current reading cannot redefine its own monotonic floor.
 *
 * @param baseline Frozen quota baseline for the active confirmation sequence.
 * @param previous Snapshot remembered before the current read or notification.
 * @param incoming Current quota payload that exposed the missing window.
 * @returns Baseline extended with previously accepted missing windows.
 */
function extendLowerQuotaBaseline(
  baseline: TokenPayload,
  previous: TokenPayload,
  incoming: TokenPayload,
): TokenPayload {
  const extendRateLimits = (
    current: TokenPayload['rateLimits'],
    old: TokenPayload['rateLimits'],
    next: TokenPayload['rateLimits'],
  ): TokenPayload['rateLimits'] => {
    if (!old || !next) return current
    const fiveHour = current?.fiveHour ?? (next.fiveHour ? old.fiveHour : undefined)
    const sevenDay = current?.sevenDay ?? (next.sevenDay ? old.sevenDay : undefined)
    if (!fiveHour && !sevenDay) return current
    return { fiveHour, sevenDay }
  }

  let rateLimits = baseline.rateLimits
  const baselineFamily = baseline.rateLimitId ?? 'active'
  const previousFamily = previous.rateLimitId ?? 'active'
  const incomingFamily = incoming.rateLimitId ?? 'active'
  if (baselineFamily === previousFamily && previousFamily === incomingFamily) {
    rateLimits = extendRateLimits(rateLimits, previous.rateLimits, incoming.rateLimits)
  }

  const quotaBuckets: Record<string, TokenQuotaBucket> = { ...(baseline.quotaBuckets ?? {}) }
  for (const [incomingKey, incomingBucket] of Object.entries(incoming.quotaBuckets ?? {})) {
    const family = incomingBucket.rateLimitId ?? incomingKey
    const previousEntry = findQuotaBucket(previous, family)
    if (!previousEntry) continue
    const baselineEntry = findQuotaBucket(baseline, family)
    const bucketKey = baselineEntry?.key ?? previousEntry.key
    const rateLimitsForBucket = extendRateLimits(
      baselineEntry?.bucket.rateLimits,
      previousEntry.bucket.rateLimits,
      incomingBucket.rateLimits,
    )
    if (!rateLimitsForBucket) continue
    quotaBuckets[bucketKey] = {
      ...previousEntry.bucket,
      ...baselineEntry?.bucket,
      rateLimits: rateLimitsForBucket,
    }
  }

  return {
    ...baseline,
    ...(rateLimits ? { rateLimits } : {}),
    ...(Object.keys(quotaBuckets).length > 0 ? { quotaBuckets } : {}),
  }
}

/** Quota-bucket lookup result retaining the serialized object key. */
interface QuotaBucketEntry {
  /** Key used by the token's quotaBuckets record. */
  key: string
  /** Native quota bucket stored under the key. */
  bucket: TokenQuotaBucket
}

/**
 * Finds a named quota bucket by its native family identifier.
 *
 * @param token Token payload whose named buckets should be searched.
 * @param family Native rate-limit family identifier.
 * @returns Matching bucket and record key, or `undefined` when absent.
 */
function findQuotaBucket(token: TokenPayload, family: string): QuotaBucketEntry | undefined {
  for (const [key, bucket] of Object.entries(token.quotaBuckets ?? {})) {
    if ((bucket.rateLimitId ?? key) === family) return { key, bucket }
  }
  return undefined
}

/**
 * Compares the official period metadata of two rolling quota windows.
 *
 * @param previous Previous physical quota window.
 * @param incoming Current physical quota window.
 * @returns Whether both values describe the same reset period.

 */
function sameQuotaPeriod(previous: TokenRateLimitWindow, incoming: TokenRateLimitWindow): boolean {
  if (
    previous.windowMinutes !== undefined &&
    incoming.windowMinutes !== undefined &&
    previous.windowMinutes !== incoming.windowMinutes
  ) {
    return false
  }
  if (previous.resetsAt === undefined || incoming.resetsAt === undefined) return true
  return Math.abs(previous.resetsAt - incoming.resetsAt) <= 60
}

/**
 * Flattens quota families while retaining full rolling-window metadata.
 *
 * @param token Normalized token payload containing account quota.
 * @returns Windows keyed by native quota family and window kind.

 */
function quotaWindowsByKey(token: TokenPayload): ReadonlyMap<string, TokenRateLimitWindow> {
  const values = new Map<string, TokenRateLimitWindow>()
  /**
   * Adds both rolling windows for one native quota family.
   *
   * @param family Stable quota-family identifier.
   * @param rateLimits Rolling windows reported for the family.

   */
  const add = (family: string, rateLimits: TokenPayload['rateLimits']): void => {
    if (rateLimits?.fiveHour) values.set(`${family}\0fiveHour`, rateLimits.fiveHour)
    if (rateLimits?.sevenDay) values.set(`${family}\0sevenDay`, rateLimits.sevenDay)
  }
  add(token.rateLimitId ?? 'active', token.rateLimits)
  for (const [key, bucket] of Object.entries(token.quotaBuckets ?? {})) {
    add(bucket.rateLimitId ?? key, bucket.rateLimits)
  }
  return values
}

/**
 * Flattens named account quota families into comparable rolling-window values.
 *
 * @param token Normalized token payload containing account quota.
 * @returns Usage percentages keyed by quota family and window kind.

 */
function quotaUsageByWindow(token: TokenPayload): ReadonlyMap<string, number> {
  const values = new Map<string, number>()
  for (const [key, window] of quotaWindowsByKey(token)) {
    const usedPercent = window.usedPercent
    if (usedPercent !== undefined && Number.isFinite(usedPercent)) {
      values.set(key, usedPercent)
    }
  }
  return values
}

/**
 * Clamps only decreased notification windows back to the previous snapshot.
 *
 * @param incoming Sparse-notification result after normal merging.
 * @param previous Last full or notification snapshot accepted by the service.
 * @returns Token retaining lower old values while preserving same-frame increases.

 */
function retainPreviousLowerQuota(incoming: TokenPayload, previous: TokenPayload): TokenPayload {
  /**
   * Clamps decreased windows in one rate-limit pair to their accepted values.
   *
   * @param next Newly observed rolling windows.
   * @param old Previously accepted rolling windows.
   * @returns Windows with isolated decreases replaced by their old values.

   */
  const clampRateLimits = (
    next: TokenPayload['rateLimits'],
    old: TokenPayload['rateLimits'],
  ): TokenPayload['rateLimits'] => {
    if (!next || !old) return next
    /**
         * Retains an accepted window when its replacement moves usage backward.
         *
         * @param candidate Newly observed rolling window.
         * @param accepted Previously accepted rolling window.
         * @returns Candidate window unless it is a lower reading.

         */
    const clamp = (
      candidate: TokenRateLimitWindow | undefined,
      accepted: TokenRateLimitWindow | undefined,
    ): TokenRateLimitWindow | undefined => {
      if (
        candidate?.usedPercent !== undefined &&
        accepted?.usedPercent !== undefined &&
        candidate.usedPercent < accepted.usedPercent
      ) {
        return accepted
      }
      return candidate
    }
    return {
      fiveHour: clamp(next.fiveHour, old.fiveHour),
      sevenDay: clamp(next.sevenDay, old.sevenDay),
    }
  }

  const buckets: Record<string, TokenQuotaBucket> = {}
  for (const [key, bucket] of Object.entries(incoming.quotaBuckets ?? {})) {
    const oldBucket = previous.quotaBuckets?.[key]
    buckets[key] = {
      ...bucket,
      rateLimits: clampRateLimits(bucket.rateLimits, oldBucket?.rateLimits),
    }
  }
  return {
    ...incoming,
    rateLimits: clampRateLimits(incoming.rateLimits, previous.rateLimits),
    ...(Object.keys(buckets).length > 0 ? { quotaBuckets: buckets } : {}),
  }
}

/**
 * Retains quota windows omitted by an otherwise authoritative physical read.
 *
 * The returned value is service-private memory for merging later sparse push
 * updates. Callers still publish the unmerged physical response so an omitted
 * lower window cannot advance reset confirmation.
 *
 * @param previous Complete quota remembered from earlier reads.
 * @param incoming Newly normalized physical or notification payload.
 * @returns Complete quota memory with incoming fields taking precedence.

 */
function mergeQuotaPayload(
  previous: TokenPayload | undefined,
  incoming: TokenPayload,
): TokenPayload {
  if (!previous) return incoming
  const quotaBuckets: Record<string, TokenQuotaBucket> = { ...(previous.quotaBuckets ?? {}) }
  for (const [key, bucket] of Object.entries(incoming.quotaBuckets ?? {})) {
    const oldBucket = quotaBuckets[key]
    quotaBuckets[key] = {
      ...oldBucket,
      ...bucket,
      rateLimits: mergeRateLimits(oldBucket?.rateLimits, bucket.rateLimits),
    }
  }
  const sameActiveFamily =
    !previous.rateLimitId || !incoming.rateLimitId || previous.rateLimitId === incoming.rateLimitId
  return {
    ...previous,
    ...incoming,
    rateLimits: sameActiveFamily
      ? mergeRateLimits(previous.rateLimits, incoming.rateLimits)
      : incoming.rateLimits,
    ...(Object.keys(quotaBuckets).length > 0 ? { quotaBuckets } : {}),
  }
}

/**
 * Merges a sparse notification into the previously emitted quota payload.
 *
 * @param previous Previously emitted quota payload.
 * @param incoming Newly normalized sparse bucket.
 * @param updatedAt Epoch milliseconds assigned to the merged bucket.
 * @returns The complete merged quota payload.

 */
function mergeQuotaUpdate(
  previous: TokenPayload | undefined,
  incoming: TokenQuotaBucket,
  updatedAt: number,
): TokenPayload {
  const id = incoming.rateLimitId ?? previous?.rateLimitId ?? 'codex'
  const oldBucket = previous?.quotaBuckets?.[id]
  const activeRateLimits =
    !previous?.rateLimitId || previous.rateLimitId === id ? previous?.rateLimits : undefined
  const mergedRateLimits = mergeRateLimits(
    oldBucket?.rateLimits ?? activeRateLimits,
    incoming.rateLimits,
  )
  const bucket: TokenQuotaBucket = {
    ...oldBucket,
    ...incoming,
    rateLimitId: id,
    rateLimits: mergedRateLimits,
    updatedAt,
  }
  const updatesActiveBucket = !previous?.rateLimitId || previous.rateLimitId === id
  return {
    ...previous,
    rateLimits: updatesActiveBucket ? mergedRateLimits : previous.rateLimits,
    quotaBuckets: { ...(previous?.quotaBuckets ?? {}), [id]: bucket },
    rateLimitId: updatesActiveBucket ? id : previous.rateLimitId,
    rateLimitName: updatesActiveBucket
      ? (incoming.rateLimitName ?? previous?.rateLimitName)
      : previous.rateLimitName,
    accuracy: 'exact',
  }
}

/**
 * Merges independently sparse five-hour and seven-day windows.
 *
 * @param previous Previously known rate-limit windows.
 * @param incoming Newly reported rate-limit windows.
 * @returns The merged window set.

 */
function mergeRateLimits(
  previous: TokenPayload['rateLimits'],
  incoming: TokenPayload['rateLimits'],
): TokenPayload['rateLimits'] {
  if (!previous) return incoming
  if (!incoming) return previous
  return {
    fiveHour: mergeWindow(previous.fiveHour, incoming.fiveHour),
    sevenDay: mergeWindow(previous.sevenDay, incoming.sevenDay),
  }
}

/**
 * Merges one sparse quota window without treating omitted data as deletion.
 *
 * @param previous Previously known quota window.
 * @param incoming Newly reported quota window.
 * @returns The merged quota window.

 */
function mergeWindow(
  previous: TokenRateLimitWindow | undefined,
  incoming: TokenRateLimitWindow | undefined,
): TokenRateLimitWindow | undefined {
  if (!previous) return incoming
  if (!incoming) return previous
  return { ...previous, ...incoming }
}

/**
 * Returns an object record or `undefined`.
 *
 * @param value Value to narrow.
 * @returns The narrowed object record.

 */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : undefined
}

/**
 * Returns a finite number or `undefined`.
 *
 * @param value Numeric value or string to parse.
 * @returns A finite number, if parsing succeeds.

 */
function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Returns a valid JSON-RPC request identifier or `undefined`.
 *
 * @param value Candidate request identifier.
 * @returns A string or integer request identifier.

 */
function requestIdValue(value: unknown): number | string | undefined {
  if (typeof value === 'string') return value
  const parsed = numberValue(value)
  return parsed != null && Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Returns a non-empty string or `undefined`.
 *
 * @param value Candidate string value.
 * @returns A non-empty string, if supplied.

 */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Returns a boolean or `undefined`.
 *
 * @param value Candidate boolean value.
 * @returns The boolean value, if supplied.

 */
function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * Normalizes epoch seconds or milliseconds to epoch seconds.
 *
 * @param value Candidate epoch timestamp.
 * @returns Positive epoch seconds, if valid.

 */
function epochSeconds(value: unknown): number | undefined {
  const parsed = numberValue(value)
  if (parsed == null || parsed <= 0) return undefined
  return parsed > 1_000_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed)
}

/**
 * Waits for a short burst interval.
 *
 * @param milliseconds Delay duration.
 * @returns A promise that resolves after the delay.

 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

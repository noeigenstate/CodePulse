/**
 * `@codepulse/local-server` —— 接收 hook 事件并暴露当前状态的
 * 回环 HTTP + WebSocket 服务（需求 §5.9）。
 *
 * @module local-server

 */
import Fastify, { type FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import {
  DEFAULT_SERVER_HOST,
  DEFAULT_SERVER_PORT,
  type AgentEvent,
  type AgentEventType,
} from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import { registerAgentRoutes } from './routes/agents.js'
import { registerEventRoutes } from './routes/events.js'
import { registerStatusRoutes } from './routes/status.js'
import { QuotaRefreshWatcher } from './quota-watcher.js'
import { SessionSyncService } from './session-sync.js'
import type { MimoCookieProvider } from './mimo-quota.js'
import {
  CodexAppServerQuotaService,
  type CodexAppServerQuotaServiceOptions,
  type CodexAppServerQuotaSnapshot,
} from './codex-app-server.js'
import { registerWebSocket } from './websocket/index.js'
import {
  defaultLocalAuthPath,
  loadOrCreateLocalAuthToken,
  registerLocalAuthGuard,
} from './local-auth.js'

/**
 * {@link startLocalServer} 的选项。

 */
export interface LocalServerOptions {
  /** 服务器读取状态并投喂事件的状态 hub。 */
  hub: StatusHub
  /** 绑定主机（默认回环地址 `127.0.0.1`）。 */
  host?: string
  /** 绑定端口（默认 `17888`）。 */
  port?: number
  /** 启用 Fastify 请求日志（默认关闭）。 */
  logger?: boolean
  /** 禁用本机 CLI 会话主动扫描（测试用）。 */
  disableSessionSync?: boolean
  /** Disables the read-only Codex App Server quota client, primarily for tests. */
  disableCodexAppServer?: boolean
  /** Creates the Codex quota service; tests may inject an in-memory protocol fake. */
  codexQuotaServiceFactory?: CodexQuotaServiceFactory
  /**
   * 本机 API 认证：
   * - 省略：生成/复用 `~/.codepulse/local-auth` 中的 token（生产默认）
   * - string：使用给定 token
   * - false：关闭认证（仅测试）

   */
  authToken?: string | false
  /** 覆盖 local-auth 文件路径（测试）。 */
  authTokenPath?: string
  /** Supplies the MiMo console cookie for OpenCode Token Plan quota (desktop login window). */
  mimoCookieProvider?: MimoCookieProvider
}

/** Minimal lifecycle used by the local server for Codex quota synchronization. */
export interface CodexQuotaService {
  /**
   * Returns the operating-system identifier of the current App Server child.
   *
   * @returns Current child PID, or `undefined` when unavailable.

   */
  getProcessId?(): number | undefined
  /**
   * Starts the protocol connection and its first read burst.
   *
   * @returns A promise that settles after startup completes.

   */
  start(): Promise<void>
  /** Stops protocol timers and the child process. */
  stop(): void
  /**
   * Schedules one coalesced three-read quota burst.
   *
   * @returns The newest quota snapshot, or `undefined` when none is available.

   */
  refresh(): Promise<CodexAppServerQuotaSnapshot | undefined>
}

/**
 * Factory seam for constructing the Codex App Server quota service.
 *
 * @param options Protocol callbacks and process overrides for the quota service.
 * @returns A Codex quota service with the required local-server lifecycle.

 */
export type CodexQuotaServiceFactory = (
  options: CodexAppServerQuotaServiceOptions,
) => CodexQuotaService

/**
 * 一个运行中的本地服务器实例。

 */
export interface LocalServer {
  /** 底层 Fastify 实例。 */
  app: FastifyInstance
  /** 服务器监听的基础 URL。 */
  url: string
  /** 本机 API token；auth 关闭时为 undefined。 */
  authToken?: string
  /** 立即再扫一轮本机 CLI 会话（窗口聚焦时调用）。 */
  syncSessions: () => Promise<void>
  /**
   * Re-queries MiMo Token Plan quota right away (after login or logout).
   * @param options `clear` drops the cached quota so a logout stops publishing it.
   */
  refreshMimoQuota: (options?: { clear?: boolean }) => Promise<void>
  /** 停止服务器并释放端口。 */
  close: () => Promise<void>
}

/**
 * 构建并启动本地 HTTP + WebSocket 服务（需求 §5.9）。
 *
 * 默认仅绑定回环地址，绝不暴露到网络。针对给定的 hub
 * 注册 WebSocket 通道与事件/状态路由。
 *
 * @param options hub 加可选的主机/端口/日志覆盖项。
 * @returns 运行中的服务器、其 URL 及 `close` 函数。
 * @throws 端口绑定失败时抛出（调用方不得再配置 Hook）。

 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const host = options.host ?? DEFAULT_SERVER_HOST
  const port = options.port ?? DEFAULT_SERVER_PORT

  const authToken =
    options.authToken === false
      ? undefined
      : typeof options.authToken === 'string'
        ? options.authToken
        : loadOrCreateLocalAuthToken(options.authTokenPath ?? defaultLocalAuthPath())

  const app = Fastify({ logger: options.logger ?? false })

  if (authToken) {
    registerLocalAuthGuard(app, authToken)
  }

  await app.register(websocket)

  // App Server authority is intentionally sticky for this process. A temporary
  // disconnect must never allow account-unknown rollout quota back into the UI.
  let codexQuotaAuthoritative = false
  let observedCodexAccountScope: string | undefined
  let publishedCodexAccountScope: string | undefined
  let codexQuotaSampleSequence = 0
  let codexQuotaService: CodexQuotaService | undefined
  const codexTerminalRefreshes = new CodexTerminalRefreshRegistry()

  const quotaWatcher = new QuotaRefreshWatcher({
    hub: options.hub,
    isCodexQuotaAuthoritative: () => codexQuotaAuthoritative,
    // Production: keep re-reading bound rollouts after reset / idle wait.
    // Tests inject their own watcher options via direct construction.
  })
  const onHubEvent = (event: Parameters<typeof quotaWatcher.observe>[0]): void => {
    quotaWatcher.observe(event)
  }
  options.hub.on('event', onHubEvent)

  const sessionSync = options.disableSessionSync
    ? undefined
    : new SessionSyncService({
        hub: options.hub,
        mimoCookieProvider: options.mimoCookieProvider,
        isCodexQuotaAuthoritative: () => codexQuotaAuthoritative,
        excludedCodexProcessIds: () => {
          const pid = codexQuotaService?.getProcessId?.()
          return pid === undefined ? [] : [pid]
        },
      })

  /**
   * Establishes an account boundary before any later rollout read can publish.
   *
   * @param scope Stable identity of the currently authenticated Codex account.

   */
  const observeCodexAccountScope = (scope: string): void => {
    if (scope === observedCodexAccountScope) return
    observedCodexAccountScope = scope
    codexQuotaAuthoritative = true
    quotaWatcher.reset()
    sessionSync?.resetCodexAccountState()
    options.hub.invalidateAgentQuota('codex')
    publishedCodexAccountScope = scope
  }

  /**
   * Atomically replaces rollout quota with one official App Server snapshot.
   *
   * @param snapshot Authoritative quota snapshot reported by Codex App Server.

   */
  const observeCodexQuotaSnapshot = (snapshot: CodexAppServerQuotaSnapshot): void => {
    observeCodexAccountScope(snapshot.accountScope)
    const accountChanged = publishedCodexAccountScope !== snapshot.accountScope
    if (accountChanged) {
      options.hub.invalidateAgentQuota('codex', { emitStatus: false })
      publishedCodexAccountScope = snapshot.accountScope
    }

    codexQuotaSampleSequence += 1
    const observationId = `codex-app-server:${snapshot.updatedAt}:${codexQuotaSampleSequence}`
    options.hub.observeQuota({
      id: observationId,
      source: 'codex',
      eventType: 'token_snapshot',
      token: snapshot.token,
      timestamp: snapshot.updatedAt,
      internal: {
        quotaRefresh: true,
        usageSampleId: observationId,
        quotaObservationSource: snapshot.source,
      },
    })
  }

  /**
   * Creates the production or injected Codex quota service.
   *
   * @param serviceOptions Account and snapshot callbacks for the service.
   * @returns Quota service used by this local-server instance.

   */
  const createCodexQuotaService =
    options.codexQuotaServiceFactory ??
    ((serviceOptions: CodexAppServerQuotaServiceOptions) =>
      new CodexAppServerQuotaService(serviceOptions))
  codexQuotaService = options.disableCodexAppServer
    ? undefined
    : createCodexQuotaService({
        onAccountScope: observeCodexAccountScope,
        onSnapshot: observeCodexQuotaSnapshot,
      })

  registerWebSocket(app, options.hub)
  registerAgentRoutes(app)
  registerEventRoutes(app, options.hub, {
    isCodexQuotaAuthoritative: () => codexQuotaAuthoritative,
    onCodexEvent: (event) => {
      if (!codexTerminalRefreshes.shouldRefresh(event)) return
      void codexQuotaService?.refresh()
      void sessionSync?.syncNow(['codex'])
    },
  })
  registerStatusRoutes(app, options.hub)

  try {
    await app.listen({ host, port })
    // The hook endpoint is live before disk or child-process hydration starts.
    const codexQuotaStart = codexQuotaService?.start().catch(() => undefined)
    await sessionSync?.start()
    // Do not hold desktop startup on an optional CLI protocol. The service has
    // bounded retries and updates Hub asynchronously after the window is ready.
    void codexQuotaStart
  } catch (err) {
    sessionSync?.stop()
    codexQuotaService?.stop()
    quotaWatcher.stop()
    options.hub.off('event', onHubEvent)
    try {
      await app.close()
    } catch {
      // ignore
    }
    throw err
  }

  return {
    app,
    url: `http://${host}:${port}`,
    authToken,
    syncSessions: async () => {
      await Promise.all([sessionSync?.syncNow(), codexQuotaService?.refresh()])
    },
    refreshMimoQuota: async (refreshOptions) => {
      sessionSync?.refreshMimoQuota(refreshOptions)
      await sessionSync?.syncNow(['opencode'])
    },
    close: async () => {
      sessionSync?.stop()
      codexQuotaService?.stop()
      quotaWatcher.stop()
      options.hub.off('event', onHubEvent)
      await app.close()
    },
  }
}

/** Maximum gap used to collapse terminal aliases from one Codex turn. */
const CODEX_TERMINAL_ALIAS_WINDOW_MS = 2_000
/** Maximum retained session keys for terminal refresh deduplication. */
const MAX_CODEX_TERMINAL_REFRESH_KEYS = 256

/**
 * Suppresses duplicate disk/API refreshes emitted by aliases of one terminal turn.
 *
 * Codex can emit `Stop` followed by `SessionEnd` for the same completed turn.
 * The first event refreshes immediately; the alias is ignored without delaying
 * the user-visible result. A new prompt clears the session marker.

 */
class CodexTerminalRefreshRegistry {
  private readonly recent = new Map<string, { externalTurnId?: string; observedAt: number }>()

  /**
   * Decides whether one Codex event warrants a new terminal refresh.
   *
   * @param event Normalized Codex hook event.
   * @returns Whether quota and rollout readers should run immediately.

   */
  shouldRefresh(event: AgentEvent): boolean {
    const key = event.externalSessionId ?? event.workspacePath ?? event.cwd
    if (event.eventType === 'prompt_submit') {
      if (key) this.recent.delete(key)
      return false
    }
    if (!shouldRefreshCodexQuota(event.eventType)) return false
    if (!key) return true

    const now = Date.now()
    const previous = this.recent.get(key)
    const sameTurn =
      previous?.externalTurnId !== undefined &&
      event.externalTurnId !== undefined &&
      previous.externalTurnId === event.externalTurnId
    const terminalAlias =
      event.eventType === 'session_end' &&
      event.externalTurnId === undefined &&
      previous !== undefined
    if (
      previous &&
      now - previous.observedAt <= CODEX_TERMINAL_ALIAS_WINDOW_MS &&
      (sameTurn || terminalAlias)
    ) {
      return false
    }

    this.recent.delete(key)
    this.recent.set(key, {
      externalTurnId: event.externalTurnId,
      observedAt: now,
    })
    while (this.recent.size > MAX_CODEX_TERMINAL_REFRESH_KEYS) {
      const oldest = this.recent.keys().next().value as string | undefined
      if (!oldest) break
      this.recent.delete(oldest)
    }
    return true
  }
}

/**
 * Selects lifecycle boundaries that warrant immediate Codex session and quota refreshes.
 *
 * Tool start/end hooks can be extremely frequent and do not close a turn. App
 * Server notifications plus the steady poll cover them without spawning a new
 * burst for every command.
 *
 * @param eventType Normalized Codex lifecycle event type.
 * @returns Whether the event should trigger an immediate read burst.

 */
function shouldRefreshCodexQuota(eventType: AgentEventType): boolean {
  return (
    eventType === 'turn_stop' ||
    eventType === 'turn_error' ||
    eventType === 'turn_cancelled' ||
    eventType === 'usage_limited' ||
    eventType === 'session_end'
  )
}

export {
  MIMO_PLATFORM_API_BASE,
  type MimoCookieProvider,
  type MimoCookieRequest,
} from './mimo-quota.js'
export {
  commandCandidates,
  detectAgents,
  detectClaudeAgent,
  detectCodexAgent,
  detectGrokAgent,
  detectKimiAgent,
  type AgentDetectOptions,
} from './agent-detect.js'
export {
  configureAgents,
  configureClaudeAgent,
  configureCodexAgent,
  configureGrokAgent,
  configureKimiAgent,
  cleanupAgents,
  cleanupClaudeAgent,
  cleanupCodexAgent,
  cleanupGrokAgent,
  cleanupKimiAgent,
  publishStableHookLaunchers,
  type AgentConfigurationOptions,
  type AgentConfigurationResult,
  type AgentConfigurationStatus,
} from './agent-config.js'
export { registerAgentRoutes, registerEventRoutes, registerStatusRoutes, registerWebSocket }
export {
  CodexAppServerQuotaService,
  createCodexAccountScope,
  normalizeCodexRateLimitsResponse,
  resolveCodexAppServerCommand,
  type CodexAppServerChild,
  type CodexAppServerCommand,
  type CodexAppServerQuotaServiceOptions,
  type CodexAppServerQuotaSnapshot,
  type CodexAppServerReadable,
  type CodexAppServerSpawn,
  type CodexAppServerSpawnOptions,
  type CodexAppServerWritable,
} from './codex-app-server.js'
export {
  QuotaRefreshWatcher,
  readCodexQuotaObservationFromFile,
  readCodexQuotaTokenFromFile,
  readCodexRolloutSnapshotFromFile,
  type CodexQuotaObservation,
  type CodexRolloutSnapshot,
} from './quota-watcher.js'
export {
  isCliProcessAlive,
  SessionSyncService,
  type CliProcessAliveOptions,
  type SessionSyncOptions,
  type SessionSyncSource,
} from './session-sync.js'
export {
  resolveEventWorkspacePaths,
  WorkspacePathResolver,
  type WorkspacePathResolverOptions,
} from './workspace-path.js'
export {
  claudeQuotaCachePath,
  fetchClaudeOauthUsage,
  mergeClaudeContextWithQuota,
  normalizeClaudeRateLimitsPayload,
  readClaudeQuotaCache,
  resolveClaudeAccountQuota,
  writeClaudeQuotaCache,
  type ClaudeQuotaSnapshot,
} from './claude-quota.js'
export {
  fetchKimiManagedUsage,
  kimiQuotaCachePath,
  normalizeKimiManagedUsage,
  readKimiQuotaCache,
  resolveKimiAccountQuota,
  type KimiQuotaSnapshot,
} from './kimi-quota.js'
export {
  defaultLocalAuthPath,
  generateLocalAuthToken,
  loadOrCreateLocalAuthToken,
  readLocalAuthToken,
  LOCAL_AUTH_HEADER,
  LOCAL_AUTH_QUERY,
} from './local-auth.js'
export {
  defaultDeviceAuthPath,
  generateDeviceAuthToken,
  loadOrCreateDeviceAuthToken,
  readDeviceAuthToken,
  DEVICE_AUTH_HEADER,
} from './device-auth.js'
export {
  assertValidDeviceServerId,
  defaultDeviceServerIdPath,
  generateDeviceServerId,
  loadOrCreateDeviceServerId,
  readDeviceServerId,
} from './device-server-id.js'
export {
  publishDeviceMdns,
  DEVICE_MDNS_PROTOCOL,
  DEVICE_MDNS_TYPE,
  type DeviceMdnsPublisher,
  type DeviceMdnsPublisherOptions,
} from './device-discovery.js'
export {
  readDeviceServerConfig,
  startDeviceServer,
  DEVICE_HEALTH_PATH,
  DEVICE_SERVER_ENABLED_ENV,
  DEVICE_SERVER_HOST_ENV,
  DEVICE_SERVER_PORT_ENV,
  DEVICE_SERVER_TOKEN_ENV,
  DEVICE_STATUS_PATH,
  type DeviceServer,
  type DeviceServerConfig,
  type DeviceServerOptions,
} from './device-server.js'

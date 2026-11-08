import {
  normalizePluginCard,
  isPluginId,
  type AmbientCard,
  type ClientInstalledPlugin,
} from '@codepulse/shared'
import { pluginPlatformUrl } from '../plugin-platform-config.js'
import { isDeepStrictEqual } from 'node:util'

interface ClientCredentials {
  clientId: string
  token: string
}
interface CredentialIO {
  available: () => boolean
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
  read: () => Record<string, unknown>
  write: (value: Record<string, unknown>) => void
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
function credentials(value: unknown): ClientCredentials | null {
  const c = record(value)
  return typeof c.clientId === 'string' &&
    c.clientId.length > 0 &&
    c.clientId.length <= 256 &&
    typeof c.token === 'string' &&
    /^[\x21-\x7e]{1,4096}$/.test(c.token)
    ? { clientId: c.clientId, token: c.token }
    : null
}

/** The encrypted value is bound to its server so a changed URL never receives an old token. */
export class PluginCredentialStore {
  private value: ClientCredentials | null = null
  constructor(
    private baseUrl: string,
    private io: CredentialIO,
  ) {
    if (!io.available()) return
    try {
      const encrypted = io.read().client
      if (typeof encrypted !== 'string') return
      const saved = record(JSON.parse(io.decrypt(Buffer.from(encrypted, 'base64'))))
      if (saved.baseUrl === baseUrl) this.value = credentials(saved)
    } catch {
      // A locked or damaged store requires registration again, never a plaintext fallback.
    }
  }
  available(): boolean {
    return this.io.available()
  }
  get(): ClientCredentials | null {
    return this.value ? { ...this.value } : null
  }
  set(value: ClientCredentials): void {
    if (!this.available()) throw Error('系统加密存储不可用，未保存客户端')
    try {
      const client = this.io.encrypt(JSON.stringify({ ...value, baseUrl: this.baseUrl }))
      this.io.write({ client: client.toString('base64') })
    } catch {
      throw Error('客户端凭据未能保存')
    }
    this.value = { ...value }
  }
  clear(): void {
    this.value = null
    this.io.write({})
  }
}

export type PluginOpenResult = { url: string } | { error: string }
export interface PluginOpenOptions {
  route?: string
  embed?: boolean
  theme?: 'light' | 'dark'
}
export type PluginMutationResult = { ok: true } | { error: string }
export interface CloudPluginsResult {
  state: 'unregistered' | 'offline' | 'ok'
  platformOrigin: string
  plugins: ClientInstalledPlugin[]
}

function validPluginRoute(route: unknown): route is string {
  return (
    typeof route === 'string' &&
    (['#/discover', '#/developer', '#/review'].includes(route) ||
      (route.startsWith('#/plugin/') && isPluginId(route.slice('#/plugin/'.length))))
  )
}

const POLL_MS = 15 * 60000

export class PluginSource {
  readonly baseUrl: string
  private value: AmbientCard[] = []
  private timer?: ReturnType<typeof setTimeout>
  private running = false
  private stopped = false
  private pending?: Promise<void>
  private registration?: Promise<ClientCredentials>
  private controllers = new Set<AbortController>()
  private nextPollAt = 0
  private generation = 0
  private installed: ClientInstalledPlugin[] = []
  private listing?: Promise<CloudPluginsResult>
  private feedState?: { cards: unknown[]; errors: Record<string, unknown> }
  private online?: boolean
  constructor(
    private deps: {
      baseUrl?: string
      credentials: PluginCredentialStore
      fetch: typeof fetch
      changed: () => void
      now?: () => number
      timeoutMs?: number
    },
  ) {
    this.baseUrl = pluginPlatformUrl(deps.baseUrl)
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
  cards(): AmbientCard[] {
    return structuredClone(this.value.filter((card) => card.expiresAt > this.now()))
  }
  start(): void {
    this.stopped = false
    this.running = true
    if (this.pending || this.timer) return
    void this.refresh()
  }
  stop(): void {
    this.running = false
    this.stopped = true
    this.generation++
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    for (const controller of this.controllers) controller.abort()
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.running || !this.deps.credentials.get()) return
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        void this.refresh()
      },
      Math.min(2147483647, Math.max(0, this.nextPollAt - this.now())),
    )
    this.timer.unref?.()
  }
  private async request(
    path: string,
    token?: string,
    method = 'POST',
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await this.deps.fetch(`${this.baseUrl}/api/v1${path}`, {
            method,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
          })
          if (controller.signal.aborted) throw Error('插件平台未连接')
          if (response.status === 401 && this.deps.credentials.get()?.token === token) {
            this.value = []
            this.feedState = undefined
            try {
              this.deps.credentials.clear()
            } finally {
              this.changed()
            }
          }
          if (!response.ok) throw Error('插件平台未连接')
          return record(await response.json())
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort()
            reject(Error('插件平台未连接'))
          }, this.deps.timeoutMs ?? 10000)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }
  private register(): Promise<ClientCredentials> {
    this.registration ??= (async () => {
      const client = credentials(await this.request('/clients'))
      if (!client || this.stopped) throw Error('插件平台未连接')
      this.deps.credentials.set(client)
      this.installed = []
      return client
    })().finally(() => {
      this.registration = undefined
    })
    return this.registration
  }
  async open(theme: 'light' | 'dark', options: PluginOpenOptions = {}): Promise<PluginOpenResult> {
    if (
      !options ||
      typeof options !== 'object' ||
      Array.isArray(options) ||
      (options.route !== undefined && !validPluginRoute(options.route)) ||
      (options.embed !== undefined && typeof options.embed !== 'boolean')
    )
      return { error: '插件市场地址无效' }
    if (!this.deps.credentials.available()) return { error: '系统加密存储不可用，未保存客户端' }
    try {
      const client = this.deps.credentials.get() ?? (await this.register())
      const response = await this.request('/clients/store-code', client.token)
      if (typeof response.code !== 'string' || !response.code || response.code.length > 4096)
        throw Error('插件平台未连接')
      const url = new URL(this.baseUrl)
      url.searchParams.set('code', response.code)
      url.searchParams.set('theme', theme)
      if (options.embed) url.searchParams.set('embed', 'desktop')
      if (options.route) url.hash = options.route
      void this.refresh()
      return { url: url.href }
    } catch {
      return { error: '插件平台未连接' }
    }
  }
  private cloudSnapshot(state: CloudPluginsResult['state']): CloudPluginsResult {
    return {
      state,
      platformOrigin: this.baseUrl,
      plugins: state === 'unregistered' ? [] : structuredClone(this.installed),
    }
  }
  list(): Promise<CloudPluginsResult> {
    const client = this.deps.credentials.get()
    if (!client || this.stopped)
      return Promise.resolve(this.cloudSnapshot(client ? 'offline' : 'unregistered'))
    this.listing ??= this.loadList(client).finally(() => {
      this.listing = undefined
    })
    return this.listing.then((result) => structuredClone(result))
  }
  private async loadList(client: ClientCredentials): Promise<CloudPluginsResult> {
    const generation = this.generation
    try {
      const response = await this.request('/client/installs', client.token, 'GET')
      if (!Array.isArray(response.installs)) throw Error('插件平台数据无效')
      if (
        this.stopped ||
        generation !== this.generation ||
        client.token !== this.deps.credentials.get()?.token
      )
        return this.cloudSnapshot('offline')
      const plugins = response.installs as ClientInstalledPlugin[]
      if (
        plugins.some(
          (p) =>
            !p ||
            !isPluginId(p.pluginId) ||
            typeof p.enabled !== 'boolean' ||
            !Number.isFinite(p.installedAt) ||
            !p.settings ||
            typeof p.settings !== 'object' ||
            Array.isArray(p.settings) ||
            !p.status ||
            typeof p.status.error !== 'string' ||
            (p.status.generatedAt !== null && !Number.isFinite(p.status.generatedAt)) ||
            (p.plugin !== null && (!p.plugin || p.plugin.id !== p.pluginId)),
        )
      )
        throw Error('插件平台数据无效')
      this.installed = plugins
      return this.cloudSnapshot('ok')
    } catch {
      return this.cloudSnapshot('offline')
    }
  }
  async setEnabled(id: string, enabled: boolean): Promise<PluginMutationResult> {
    if (typeof enabled !== 'boolean') return { error: '插件开关无效' }
    return this.mutate(id, 'PUT', { enabled })
  }
  async uninstall(id: string): Promise<PluginMutationResult> {
    return this.mutate(id, 'DELETE')
  }
  private async mutate(id: string, method: string, body?: unknown): Promise<PluginMutationResult> {
    if (!isPluginId(id)) return { error: '插件编号无效' }
    const client = this.deps.credentials.get()
    if (!client || this.stopped) return { error: '请先打开插件市场' }
    try {
      await this.request(`/client/installs/${id}`, client.token, method, body)
      if (this.stopped || client.token !== this.deps.credentials.get()?.token)
        return { error: '插件平台未连接' }
      this.generation++
      this.installed = this.installed.flatMap((plugin) => {
        if (plugin.pluginId !== id) return [plugin]
        if (method === 'DELETE') return []
        return [{ ...plugin, enabled: record(body).enabled as boolean }]
      })
      // Discard feeds and lists that started before this edit, without another immediate pull.
      if (method === 'DELETE' || record(body).enabled === false)
        this.value = this.value.filter((card) => card.plugin?.id !== id)
      this.changed()
      return { ok: true }
    } catch {
      return { error: '插件操作失败，请稍后重试' }
    }
  }
  refresh(afterPending = false): Promise<void> {
    // A store edit must be reflected even when the in-flight feed predates that edit.
    if (afterPending && this.pending) return this.pending.then(() => this.refresh())
    if (this.stopped || !this.deps.credentials.get()) return Promise.resolve()
    this.pending ??= this.pull().finally(() => {
      this.pending = undefined
      this.schedule()
    })
    return this.pending
  }
  private changed(): void {
    try {
      this.deps.changed()
    } catch {
      // Closing renderers must not turn a background poll into an unhandled rejection.
    }
  }
  private async pull(): Promise<void> {
    this.nextPollAt = this.now() + POLL_MS
    const generation = this.generation
    const token = this.deps.credentials.get()!.token
    try {
      const feed = await this.request('/client/cards', token, 'GET')
      const now = this.now()
      if (
        this.stopped ||
        generation !== this.generation ||
        token !== this.deps.credentials.get()?.token
      )
        return
      if (
        feed.v !== 1 ||
        !Array.isArray(feed.cards) ||
        typeof feed.generatedAt !== 'number' ||
        !Number.isFinite(feed.generatedAt) ||
        feed.generatedAt > now + 300000 ||
        typeof feed.nextPollAt !== 'number' ||
        !Number.isFinite(feed.nextPollAt)
      )
        throw Error('插件平台数据无效')
      const generatedAt = feed.generatedAt
      this.value = feed.cards.flatMap((raw): AmbientCard[] => {
        const pluginId = record(raw).pluginId
        if (!isPluginId(pluginId)) return []
        const card = normalizePluginCard(raw, now)
        if (!card) return []
        return [
          {
            ...card,
            id: `plugin:${pluginId}:${card.id}`,
            kind: 'plugin',
            plugin: { id: pluginId },
            url: '',
            publishedAt: generatedAt,
            score: 0,
            ...(card.life ? { layout: 'life' } : {}),
          },
        ]
      })
      this.nextPollAt = Math.min(now + POLL_MS, Math.max(now + 30000, feed.nextPollAt))
      const state = { cards: feed.cards, errors: record(feed.errors) }
      const changed = this.online !== true || !isDeepStrictEqual(this.feedState, state)
      this.feedState = state
      this.online = true
      if (changed) this.changed()
    } catch {
      // Offline failures never extend a previously downloaded card's deadline.
      this.nextPollAt = this.now() + 60000
      if (
        !this.stopped &&
        generation === this.generation &&
        token === this.deps.credentials.get()?.token
      ) {
        const changed = this.online !== false
        this.online = false
        if (changed) this.changed()
      }
    }
  }
}

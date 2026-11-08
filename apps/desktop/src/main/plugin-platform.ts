import { normalizePluginCard, isPluginId, type AmbientCard } from '@codepulse/shared'
import { pluginPlatformUrl } from '../plugin-platform-config.js'

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
  private async request(path: string, token?: string): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    this.controllers.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          const response = await this.deps.fetch(`${this.baseUrl}/api/v1${path}`, {
            method: path === '/client/cards' ? 'GET' : 'POST',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
          })
          if (controller.signal.aborted) throw Error('插件平台未连接')
          if (response.status === 401 && this.deps.credentials.get()?.token === token) {
            this.value = []
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
      return client
    })().finally(() => {
      this.registration = undefined
    })
    return this.registration
  }
  async open(theme: 'light' | 'dark'): Promise<PluginOpenResult> {
    if (!this.deps.credentials.available()) return { error: '系统加密存储不可用，未保存客户端' }
    try {
      const client = this.deps.credentials.get() ?? (await this.register())
      const response = await this.request('/clients/store-code', client.token)
      if (typeof response.code !== 'string' || !response.code || response.code.length > 4096)
        throw Error('插件平台未连接')
      const url = `${this.baseUrl}/?code=${encodeURIComponent(response.code)}&theme=${theme}`
      void this.refresh()
      return { url }
    } catch {
      return { error: '插件平台未连接' }
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
      const feed = await this.request('/client/cards', token)
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
    } catch {
      // Offline failures never extend a previously downloaded card's deadline.
      this.nextPollAt = this.now() + 60000
    } finally {
      if (!this.stopped) this.changed()
    }
  }
}

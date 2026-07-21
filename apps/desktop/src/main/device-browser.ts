/** 发现并验证局域网中的 CodePulse 水墨屏。仅运行于 Electron main process。 */
import Bonjour from 'bonjour-service'
import {
  DEFAULT_DISPLAY_DEVICE_PORT,
  DEVICE_PROTOCOL_VERSION,
  type CodePulseDisplayDevice,
} from '@codepulse/shared'

export const DISPLAY_MDNS_TYPE = 'codepulse-dsp'
export const DISPLAY_MDNS_PROTOCOL = 'tcp' as const
export const DISPLAY_HEALTH_PATH = '/api/v1/device/health'

const HEALTH_TIMEOUT_MS = 2_500
const BROWSE_REFRESH_MS = 5_000
const MAX_HEALTH_BODY_BYTES = 4_096
const DEVICE_ID_PATTERN = /^codepulse-[0-9a-f]{12}$/

export interface DisplayMdnsService {
  fqdn?: string
  host?: string
  port: number
  addresses?: string[]
  txt?: Record<string, unknown>
}

interface DisplayBrowserLike {
  readonly services?: DisplayMdnsService[]
  on(event: string, listener: (...args: DisplayMdnsService[]) => void): unknown
  stop(): void
  update(): void
  expire(): void
}

interface DisplayMdnsLike {
  find(
    options: { type: string; protocol: 'tcp' },
    onUp?: (service: DisplayMdnsService) => void,
  ): DisplayBrowserLike
  destroy: CallableFunction
}

export interface DisplayDeviceBrowserOptions {
  mdns?: DisplayMdnsLike
  fetch?: typeof fetch
  onUpdate?: (devices: CodePulseDisplayDevice[]) => void
  onError?: (message: string) => void
  refreshMs?: number
}

interface DeviceWaiter {
  resolve: (device: CodePulseDisplayDevice | undefined) => void
  timeout: NodeJS.Timeout
}

/** Browser 生命周期由 Electron app 管理；返回的设备一定通过 TXT/health 身份核对。 */
export class DisplayDeviceBrowser {
  private readonly mdns: DisplayMdnsLike
  private readonly fetchImpl: typeof fetch
  private readonly onUpdate?: DisplayDeviceBrowserOptions['onUpdate']
  private readonly onError?: DisplayDeviceBrowserOptions['onError']
  private readonly refreshMs: number
  private readonly devices = new Map<string, CodePulseDisplayDevice>()
  private readonly fqdnToDeviceId = new Map<string, string>()
  private readonly inFlight = new Set<string>()
  private readonly controllers = new Set<AbortController>()
  private readonly waiters = new Map<string, Set<DeviceWaiter>>()
  private browser?: DisplayBrowserLike
  private refreshTimer?: NodeJS.Timeout
  private stopped = false

  constructor(options: DisplayDeviceBrowserOptions = {}) {
    this.mdns =
      options.mdns ??
      (new Bonjour(undefined, (error: unknown) => {
        options.onError?.(safeError(error))
      }) as unknown as DisplayMdnsLike)
    this.fetchImpl = options.fetch ?? fetch
    this.onUpdate = options.onUpdate
    this.onError = options.onError
    this.refreshMs = options.refreshMs ?? BROWSE_REFRESH_MS
  }

  start(): void {
    if (this.browser || this.stopped) return
    const browser = this.mdns.find(
      { type: DISPLAY_MDNS_TYPE, protocol: DISPLAY_MDNS_PROTOCOL },
      (service) => void this.verify(service),
    )
    browser.on('down', (service) => this.removeService(service))
    browser.on('txt-update', (service) => void this.verify(service))
    browser.on('srv-update', (service) => void this.verify(service))
    this.browser = browser
    this.refreshTimer = setInterval(() => {
      try {
        browser.update()
        browser.expire()
        for (const service of browser.services ?? []) void this.verify(service)
      } catch (error) {
        this.onError?.(safeError(error))
      }
    }, this.refreshMs)
    this.refreshTimer.unref?.()
  }

  snapshot(): CodePulseDisplayDevice[] {
    return [...this.devices.values()].sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId),
    )
  }

  /** 等待指定水墨屏通过 mDNS 和 health 验证；超时不把 USB ready 降级为失败。 */
  waitForDevice(deviceId: string, timeoutMs: number): Promise<CodePulseDisplayDevice | undefined> {
    const current = this.devices.get(deviceId)
    if (current) return Promise.resolve(current)
    if (this.stopped || timeoutMs <= 0) return Promise.resolve(undefined)

    return new Promise((resolve) => {
      const waiter: DeviceWaiter = {
        resolve,
        timeout: setTimeout(() => this.finishWaiter(deviceId, waiter, undefined), timeoutMs),
      }
      waiter.timeout.unref?.()
      const group = this.waiters.get(deviceId) ?? new Set<DeviceWaiter>()
      group.add(waiter)
      this.waiters.set(deviceId, group)
    })
  }

  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    this.refreshTimer = undefined
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    try {
      this.browser?.stop()
    } catch {
      // The socket may already be closed after a transport error.
    }
    this.browser = undefined
    try {
      this.mdns.destroy()
    } catch {
      // Idempotent shutdown.
    }
    for (const [deviceId, group] of this.waiters) {
      for (const waiter of group) this.finishWaiter(deviceId, waiter, undefined)
    }
    this.devices.clear()
    this.fqdnToDeviceId.clear()
  }

  private async verify(service: DisplayMdnsService): Promise<void> {
    if (this.stopped) return
    const identity = mdnsIdentity(service)
    if (!identity) {
      this.removeService(service)
      return
    }
    const key = serviceKey(service, identity.deviceId)
    if (this.inFlight.has(key)) return
    this.inFlight.add(key)

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
    timeout.unref?.()
    this.controllers.add(controller)
    try {
      const response = await this.fetchImpl(
        `http://${urlHost(identity.address)}:${DEFAULT_DISPLAY_DEVICE_PORT}${DISPLAY_HEALTH_PATH}`,
        {
          redirect: 'error',
          signal: controller.signal,
        },
      )
      if (!response.ok) return
      const text = await response.text()
      if (Buffer.byteLength(text, 'utf8') > MAX_HEALTH_BODY_BYTES) return
      const body = parseHealth(text)
      if (!body || body.deviceId !== identity.deviceId) return

      const device: CodePulseDisplayDevice = {
        deviceId: body.deviceId,
        address: identity.address,
        port: DEFAULT_DISPLAY_DEVICE_PORT,
        path: DISPLAY_HEALTH_PATH,
        firmwareVersion: body.firmwareVersion,
        hardwareRevision: body.hardwareRevision,
        provisioned: body.provisioned,
        lastSeenAt: Date.now(),
      }
      this.devices.set(device.deviceId, device)
      this.fqdnToDeviceId.set(key, device.deviceId)
      this.emitUpdate()
      for (const waiter of this.waiters.get(device.deviceId) ?? []) {
        this.finishWaiter(device.deviceId, waiter, device)
      }
    } catch (error) {
      if (!controller.signal.aborted && !this.stopped) this.onError?.(safeError(error))
    } finally {
      clearTimeout(timeout)
      this.controllers.delete(controller)
      this.inFlight.delete(key)
    }
  }

  private removeService(service: DisplayMdnsService): void {
    const idFromTxt = textValue(service.txt?.['id'])
    const key = serviceKey(service, idFromTxt ?? '')
    const deviceId = this.fqdnToDeviceId.get(key) ?? idFromTxt
    if (!deviceId || !this.devices.delete(deviceId)) return
    this.fqdnToDeviceId.delete(key)
    this.emitUpdate()
  }

  private emitUpdate(): void {
    this.onUpdate?.(this.snapshot())
  }

  private finishWaiter(
    deviceId: string,
    waiter: DeviceWaiter,
    result: CodePulseDisplayDevice | undefined,
  ): void {
    const group = this.waiters.get(deviceId)
    if (!group?.delete(waiter)) return
    clearTimeout(waiter.timeout)
    if (group.size === 0) this.waiters.delete(deviceId)
    waiter.resolve(result)
  }
}

interface MdnsIdentity {
  deviceId: string
  address: string
}

function mdnsIdentity(service: DisplayMdnsService): MdnsIdentity | undefined {
  if (service.port !== DEFAULT_DISPLAY_DEVICE_PORT) return undefined
  if (textValue(service.txt?.['pv']) !== String(DEVICE_PROTOCOL_VERSION)) return undefined
  if (textValue(service.txt?.['path']) !== DISPLAY_HEALTH_PATH) return undefined
  const deviceId = textValue(service.txt?.['id'])
  if (!deviceId || !DEVICE_ID_PATTERN.test(deviceId)) return undefined
  const address = preferredAddress(service.addresses)
  if (!address) return undefined
  return { deviceId, address }
}

function preferredAddress(addresses: string[] | undefined): string | undefined {
  const usable = (addresses ?? []).filter((address) => address && address !== '0.0.0.0')
  return usable.find(isIpv4) ?? usable[0]
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  )
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (typeof value === 'number') return String(value)
  return undefined
}

function serviceKey(service: DisplayMdnsService, fallback: string): string {
  return service.fqdn?.trim() || `${fallback}@${service.host ?? ''}:${service.port}`
}

function urlHost(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
}

function parseHealth(
  text: string,
): Omit<CodePulseDisplayDevice, 'address' | 'port' | 'path' | 'lastSeenAt'> | undefined {
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    if (
      body['ok'] !== true ||
      body['service'] !== 'codepulse-display' ||
      body['protocolVersion'] !== DEVICE_PROTOCOL_VERSION ||
      typeof body['deviceId'] !== 'string' ||
      !DEVICE_ID_PATTERN.test(body['deviceId']) ||
      typeof body['firmwareVersion'] !== 'string' ||
      body['firmwareVersion'].length > 64 ||
      !Number.isInteger(body['hardwareRevision']) ||
      typeof body['provisioned'] !== 'boolean'
    ) {
      return undefined
    }
    return {
      deviceId: body['deviceId'],
      firmwareVersion: body['firmwareVersion'],
      hardwareRevision: body['hardwareRevision'] as number,
      provisioned: body['provisioned'],
    }
  } catch {
    return undefined
  }
}

function safeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError')
    return 'display health request timed out'
  return error instanceof Error ? error.message : 'display discovery error'
}

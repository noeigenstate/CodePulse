/** CodePulse USB CP1 扫描与配网。此模块只能由 Electron main process 调用。 */
import { randomBytes } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import {
  DEFAULT_DEVICE_SERVER_PORT,
  DEVICE_PROTOCOL_VERSION,
  type CodePulseUsbDevice,
  type DeviceProvisionRuntimeState,
  type DeviceProvisioningErrorCode,
  type DeviceProvisioningRequest,
} from '@codepulse/shared'

const CP1_PREFIX = 'CP1 '
const CP1_MAX_LINE_BYTES = 1_024
const DEVICE_ID_PATTERN = /^codepulse-[0-9a-f]{12}$/
const SERVER_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/
const DEVICE_TOKEN_PATTERN = /^[!-~]{16,128}$/
const DEFAULT_HELLO_TIMEOUT_MS = 1_500
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000
const DEFAULT_PROVISION_TIMEOUT_MS = 60_000
const DEFAULT_POLL_INTERVAL_MS = 750
const DEFAULT_SCAN_INTERVAL_MS = 2_000

export interface DeviceSerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  productId?: string
  vendorId?: string
}

export interface DeviceSerialConnection {
  readonly isOpen: boolean
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  on(event: 'error' | 'close', listener: (error?: Error) => void): unknown
  off(event: 'data', listener: (chunk: Buffer) => void): unknown
  off(event: 'error' | 'close', listener: (error?: Error) => void): unknown
  write(data: Buffer, callback: (error?: Error | null) => void): void
  drain(callback: (error?: Error | null) => void): void
  close(callback: (error?: Error | null) => void): void
}

export interface DeviceSerialAdapter {
  list(): Promise<DeviceSerialPortInfo[]>
  open(path: string): Promise<DeviceSerialConnection>
}

export interface DeviceUsbManagerOptions {
  adapter?: DeviceSerialAdapter
  helloTimeoutMs?: number
  requestTimeoutMs?: number
  provisionTimeoutMs?: number
  pollIntervalMs?: number
  scanIntervalMs?: number
  onDevices?: (devices: CodePulseUsbDevice[]) => void
}

/** token 只进入该 main-process 上下文，绝不进入 renderer 快照。 */
export interface DeviceProvisionContext {
  serverId: string
  deviceToken: string
  fallbackHost?: string
  fallbackPort?: number
}

export interface DeviceProvisionProgress {
  deviceId: string
  state: 'sending' | DeviceProvisionRuntimeState
}

export interface DeviceProvisionResult {
  deviceId: string
  state: DeviceProvisionRuntimeState
  provisioned: boolean
  wifiConnected: boolean
  desktopReachable: boolean
  configurationGeneration: number
}

interface Cp1Request {
  id: string
  protocolVersion: typeof DEVICE_PROTOCOL_VERSION
  operation: string
  params?: Record<string, unknown>
}

interface Cp1SuccessResponse {
  id: string
  ok: true
  result: unknown
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: DeviceProvisioningFailure) => void
  timer: NodeJS.Timeout
  signal?: AbortSignal
  abortListener?: () => void
}

/** 只携带稳定错误码；不保存底层帧、密码或 token。 */
export class DeviceProvisioningFailure extends Error {
  readonly code: DeviceProvisioningErrorCode

  constructor(code: DeviceProvisioningErrorCode) {
    super(code)
    this.name = 'DeviceProvisioningFailure'
    this.code = code
  }
}

/** 分块输入的 CP1 行解码器；普通固件日志与超长帧会被静默忽略。 */
export class Cp1LineDecoder {
  private readonly decoder = new StringDecoder('utf8')
  private pending = ''
  private discarding = false

  feed(chunk: Buffer): unknown[] {
    let text = this.decoder.write(chunk)
    if (this.discarding) {
      const newline = text.indexOf('\n')
      if (newline < 0) return []
      this.discarding = false
      text = text.slice(newline + 1)
    }
    this.pending += text

    const frames: unknown[] = []
    while (true) {
      const newline = this.pending.indexOf('\n')
      if (newline < 0) break
      let line = this.pending.slice(0, newline)
      this.pending = this.pending.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (Buffer.byteLength(line, 'utf8') > CP1_MAX_LINE_BYTES || !line.startsWith(CP1_PREFIX)) {
        continue
      }
      try {
        frames.push(JSON.parse(line.slice(CP1_PREFIX.length)))
      } catch {
        // Malformed firmware/log output cannot fail unrelated pending requests.
      }
    }

    if (Buffer.byteLength(this.pending, 'utf8') > CP1_MAX_LINE_BYTES) {
      this.pending = ''
      this.discarding = true
    }
    return frames
  }
}

/** 单串口 CP1 客户端；请求 id 关联响应，且从不记录原始帧。 */
export class Cp1Client {
  private readonly decoder = new Cp1LineDecoder()
  private readonly pending = new Map<string, PendingRequest>()
  private requestCounter = 0
  private closed = false

  private readonly onData = (chunk: Buffer): void => {
    for (const frame of this.decoder.feed(chunk)) this.acceptFrame(frame)
  }

  private readonly onTransportFailure = (): void => {
    this.rejectAll(new DeviceProvisioningFailure('serial_unavailable'))
  }

  constructor(private readonly port: DeviceSerialConnection) {
    port.on('data', this.onData)
    port.on('error', this.onTransportFailure)
    port.on('close', this.onTransportFailure)
  }

  async request<T>(
    operation: string,
    options: { params?: Record<string, unknown>; timeoutMs: number; signal?: AbortSignal },
  ): Promise<T> {
    if (this.closed || !this.port.isOpen) throw new DeviceProvisioningFailure('serial_unavailable')
    if (options.signal?.aborted) throw new DeviceProvisioningFailure('cancelled')

    const id = this.nextRequestId()
    const frame: Cp1Request = {
      id,
      protocolVersion: DEVICE_PROTOCOL_VERSION,
      operation,
      ...(options.params ? { params: options.params } : {}),
    }
    const response = new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.finishPending(id, new DeviceProvisioningFailure('timeout'))
        }, options.timeoutMs),
        ...(options.signal ? { signal: options.signal } : {}),
      }
      pending.timer.unref?.()
      if (options.signal) {
        pending.abortListener = () =>
          this.finishPending(id, new DeviceProvisioningFailure('cancelled'))
        options.signal.addEventListener('abort', pending.abortListener, { once: true })
      }
      this.pending.set(id, pending)
    })

    try {
      await this.writeFrame(frame)
    } catch {
      this.finishPending(id, new DeviceProvisioningFailure('serial_unavailable'))
    }
    return (await response) as T
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.port.off('data', this.onData)
    this.port.off('error', this.onTransportFailure)
    this.port.off('close', this.onTransportFailure)
    this.rejectAll(new DeviceProvisioningFailure('cancelled'))
    if (!this.port.isOpen) return
    await new Promise<void>((resolve) => {
      try {
        this.port.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  private acceptFrame(frame: unknown): void {
    if (!isRecord(frame) || typeof frame['id'] !== 'string') return
    const id = frame['id']
    const request = this.pending.get(id)
    if (!request) return

    if (frame['ok'] === true && 'result' in frame) {
      this.completePending(id, frame as unknown as Cp1SuccessResponse)
      return
    }
    if (frame['ok'] !== false || !isRecord(frame['error'])) return
    const code = normalizeFirmwareErrorCode(frame['error']['code'])
    this.finishPending(id, new DeviceProvisioningFailure(code))
  }

  private completePending(id: string, response: Cp1SuccessResponse): void {
    const request = this.pending.get(id)
    if (!request) return
    this.cleanupPending(id, request)
    request.resolve(response.result)
  }

  private finishPending(id: string, error: DeviceProvisioningFailure): void {
    const request = this.pending.get(id)
    if (!request) return
    this.cleanupPending(id, request)
    request.reject(error)
  }

  private cleanupPending(id: string, request: PendingRequest): void {
    this.pending.delete(id)
    clearTimeout(request.timer)
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener('abort', request.abortListener)
    }
  }

  private rejectAll(error: DeviceProvisioningFailure): void {
    for (const id of [...this.pending.keys()]) this.finishPending(id, error)
  }

  private async writeFrame(frame: Cp1Request): Promise<void> {
    const encoded = Buffer.from(`${CP1_PREFIX}${JSON.stringify(frame)}\n`, 'utf8')
    if (encoded.byteLength > CP1_MAX_LINE_BYTES) {
      encoded.fill(0)
      throw new DeviceProvisioningFailure('invalid_input')
    }
    try {
      await new Promise<void>((resolve, reject) => {
        this.port.write(encoded, (writeError) => {
          if (writeError) {
            reject(writeError)
            return
          }
          this.port.drain((drainError) => (drainError ? reject(drainError) : resolve()))
        })
      })
    } finally {
      // 尽早清除包含 Wi-Fi 密码/token 的可变 Buffer。
      encoded.fill(0)
    }
  }

  private nextRequestId(): string {
    this.requestCounter += 1
    return `app-${randomBytes(3).toString('hex')}-${this.requestCounter}`
  }
}

/** 扫描器与配网状态机；一个端口始终只有一个打开者。 */
export class DeviceUsbManager {
  private readonly adapter: DeviceSerialAdapter
  private readonly helloTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly provisionTimeoutMs: number
  private readonly pollIntervalMs: number
  private readonly scanIntervalMs: number
  private readonly onDevices?: DeviceUsbManagerOptions['onDevices']
  private readonly devices = new Map<string, CodePulseUsbDevice>()
  private readonly portLocks = new Set<string>()
  private scanPromise?: Promise<CodePulseUsbDevice[]>
  private scanTimer?: NodeJS.Timeout
  private scanAbort?: AbortController
  private provisionAbort?: AbortController
  private activeClient?: Cp1Client

  constructor(options: DeviceUsbManagerOptions = {}) {
    this.adapter = options.adapter ?? new NodeSerialAdapter()
    this.helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.provisionTimeoutMs = options.provisionTimeoutMs ?? DEFAULT_PROVISION_TIMEOUT_MS
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    this.scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS
    this.onDevices = options.onDevices
  }

  snapshot(): CodePulseUsbDevice[] {
    return [...this.devices.values()].sort((left, right) =>
      left.deviceId.localeCompare(right.deviceId),
    )
  }

  startScanning(): void {
    if (this.scanTimer || this.scanAbort) return
    this.scanAbort = new AbortController()
    void this.runScanLoop(this.scanAbort.signal)
  }

  stopScanning(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer)
    this.scanTimer = undefined
    this.scanAbort?.abort()
    this.scanAbort = undefined
  }

  scanOnce(signal?: AbortSignal): Promise<CodePulseUsbDevice[]> {
    if (this.scanPromise) return this.scanPromise
    this.scanPromise = this.performScan(signal).finally(() => {
      this.scanPromise = undefined
    })
    return this.scanPromise
  }

  async provision(
    request: DeviceProvisioningRequest,
    context: DeviceProvisionContext,
    onProgress: (progress: DeviceProvisionProgress) => void,
  ): Promise<DeviceProvisionResult> {
    let client: Cp1Client | undefined
    let ownsProvision = false
    let portLocked = false
    try {
      validateProvisioningInput(request, context)
      if (this.provisionAbort) throw new DeviceProvisioningFailure('serial_unavailable')
      this.stopScanning()
      const abort = new AbortController()
      this.provisionAbort = abort
      ownsProvision = true

      await this.scanPromise?.catch(() => undefined)
      if (this.portLocks.has(request.path)) {
        throw new DeviceProvisioningFailure('serial_unavailable')
      }
      this.portLocks.add(request.path)
      portLocked = true
      client = new Cp1Client(await this.adapter.open(request.path))
      this.activeClient = client
      const hello = parseDeviceInfo(
        await client.request('hello', {
          timeoutMs: this.helloTimeoutMs,
          signal: abort.signal,
        }),
      )
      if (!hello || hello.deviceId !== request.deviceId) {
        throw new DeviceProvisioningFailure('device_mismatch')
      }

      onProgress({ deviceId: hello.deviceId, state: 'sending' })
      const fallbackHost = request.fallbackHost?.trim() || context.fallbackHost?.trim()
      const fallbackPort =
        request.fallbackPort ?? context.fallbackPort ?? DEFAULT_DEVICE_SERVER_PORT
      const result = await client.request('provision', {
        params: {
          wifiSsid: request.wifiSsid,
          wifiPassword: request.wifiPassword,
          serverId: context.serverId,
          deviceToken: context.deviceToken,
          ...(fallbackHost ? { fallbackHost } : {}),
          fallbackPort,
        },
        timeoutMs: this.requestTimeoutMs,
        signal: abort.signal,
      })
      if (!isRecord(result) || result['saved'] !== true || result['applyQueued'] !== true) {
        throw new DeviceProvisioningFailure('invalid_request')
      }

      const deadline = Date.now() + this.provisionTimeoutMs
      while (Date.now() < deadline) {
        await abortableDelay(this.pollIntervalMs, abort.signal)
        const status = parseProvisionStatus(
          await client.request('getStatus', {
            timeoutMs: this.requestTimeoutMs,
            signal: abort.signal,
          }),
        )
        if (!status || status.deviceId !== hello.deviceId) {
          throw new DeviceProvisioningFailure('device_mismatch')
        }
        onProgress({ deviceId: status.deviceId, state: status.state })
        if (status.state === 'wifi_error') return status
        if (
          status.state === 'ready' &&
          status.provisioned &&
          status.wifiConnected &&
          status.desktopReachable
        ) {
          this.devices.set(request.path, { ...hello, path: request.path, provisioned: true })
          this.emitDevices()
          return status
        }
      }
      throw new DeviceProvisioningFailure('timeout')
    } finally {
      request.wifiPassword = ''
      context.deviceToken = ''
      if (ownsProvision) {
        this.activeClient = undefined
        await client?.close()
        if (portLocked) this.portLocks.delete(request.path)
        this.provisionAbort = undefined
      }
    }
  }

  async cancelProvisioning(): Promise<void> {
    this.provisionAbort?.abort()
    await this.activeClient?.close()
  }

  async close(): Promise<void> {
    this.stopScanning()
    await this.cancelProvisioning()
    await this.scanPromise?.catch(() => undefined)
  }

  private async runScanLoop(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return
    try {
      await this.scanOnce(signal)
    } catch (error) {
      if (!(error instanceof DeviceProvisioningFailure && error.code === 'cancelled')) {
        // Individual probe failures are ignored; only cancellation reaches here normally.
      }
    }
    if (signal.aborted || this.scanAbort?.signal !== signal) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined
      void this.runScanLoop(signal)
    }, this.scanIntervalMs)
    this.scanTimer.unref?.()
  }

  private async performScan(signal?: AbortSignal): Promise<CodePulseUsbDevice[]> {
    if (signal?.aborted) throw new DeviceProvisioningFailure('cancelled')
    let ports: DeviceSerialPortInfo[]
    try {
      ports = await this.adapter.list()
    } catch {
      throw new DeviceProvisioningFailure('serial_unavailable')
    }
    const candidates = ports.filter((port) => isCandidateDevicePort(port))
    const presentPaths = new Set(candidates.map((port) => port.path))
    for (const path of this.devices.keys()) {
      if (!presentPaths.has(path)) this.devices.delete(path)
    }

    for (const port of candidates) {
      if (signal?.aborted) throw new DeviceProvisioningFailure('cancelled')
      if (this.portLocks.has(port.path)) continue
      const device = await this.probe(port.path, signal)
      if (device) this.devices.set(port.path, device)
      else this.devices.delete(port.path)
    }
    this.emitDevices()
    return this.snapshot()
  }

  private async probe(path: string, signal?: AbortSignal): Promise<CodePulseUsbDevice | undefined> {
    if (this.portLocks.has(path)) return this.devices.get(path)
    this.portLocks.add(path)
    let client: Cp1Client | undefined
    try {
      client = new Cp1Client(await this.adapter.open(path))
      const hello = parseDeviceInfo(
        await client.request('hello', { timeoutMs: this.helloTimeoutMs, signal }),
      )
      if (!hello) return undefined
      try {
        const configResult = await client.request('getConfig', {
          timeoutMs: this.helloTimeoutMs,
          signal,
        })
        return parseDeviceInfo(configResult, path) ?? { ...hello, path }
      } catch {
        return { ...hello, path }
      }
    } catch {
      return undefined
    } finally {
      await client?.close()
      this.portLocks.delete(path)
    }
  }

  private emitDevices(): void {
    this.onDevices?.(this.snapshot())
  }
}

/** 限制候选范围，同时仍以 hello 而非 VID/PID 作为最终身份依据。 */
export function isCandidateDevicePort(
  port: DeviceSerialPortInfo,
  platform = process.platform,
): boolean {
  const vendorId = port.vendorId?.replace(/^0x/i, '').toLowerCase()
  const productId = port.productId?.replace(/^0x/i, '').toLowerCase()
  if (vendorId === '303a' && (!productId || productId === '1001')) return true
  if (platform === 'darwin') return /^\/dev\/cu\.usbmodem/i.test(port.path)
  if (platform === 'linux') return /^\/dev\/ttyACM\d+$/i.test(port.path)
  if (platform === 'win32') {
    return (
      /^COM\d+$/i.test(port.path) && /303a|espressif/i.test(port.pnpId ?? port.manufacturer ?? '')
    )
  }
  return false
}

class NodeSerialAdapter implements DeviceSerialAdapter {
  async list(): Promise<DeviceSerialPortInfo[]> {
    const { SerialPort } = await import('serialport')
    return SerialPort.list()
  }

  async open(path: string): Promise<DeviceSerialConnection> {
    const { SerialPort } = await import('serialport')
    const port = new SerialPort({
      path,
      baudRate: 115_200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      rtscts: false,
      // ESP32-S3 USB Serial/JTAG uses DTR/RTS transitions as reset commands.
      // Keep the idle state across probe close/open cycles.
      hupcl: false,
      autoOpen: false,
    })
    await new Promise<void>((resolve, reject) => {
      port.open((error) => (error ? reject(error) : resolve()))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        port.set({ dtr: false, rts: false }, (error) => (error ? reject(error) : resolve()))
      })
    } catch (error) {
      if (port.isOpen) {
        await new Promise<void>((resolve) => port.close(() => resolve()))
      }
      throw error
    }
    return port as unknown as DeviceSerialConnection
  }
}

function parseDeviceInfo(value: unknown, path = ''): CodePulseUsbDevice | undefined {
  if (
    !isRecord(value) ||
    value['protocolVersion'] !== DEVICE_PROTOCOL_VERSION ||
    typeof value['deviceId'] !== 'string' ||
    !DEVICE_ID_PATTERN.test(value['deviceId']) ||
    typeof value['firmwareVersion'] !== 'string' ||
    value['firmwareVersion'].length > 64 ||
    !Number.isInteger(value['hardwareRevision']) ||
    typeof value['provisioned'] !== 'boolean' ||
    !Array.isArray(value['capabilities']) ||
    !value['capabilities'].every((item) => typeof item === 'string' && item.length <= 64)
  ) {
    return undefined
  }

  const device: CodePulseUsbDevice = {
    path,
    deviceId: value['deviceId'],
    firmwareVersion: value['firmwareVersion'],
    hardwareRevision: value['hardwareRevision'] as number,
    provisioned: value['provisioned'],
    capabilities: [...value['capabilities']],
  }
  if (value['provisioned'] && validConfigFields(value)) {
    device.config = {
      wifiSsid: value['wifiSsid'] as string,
      serverId: value['serverId'] as string,
      fallbackHost: value['fallbackHost'] as string,
      fallbackPort: value['fallbackPort'] as number,
    }
  }
  return device
}

function parseProvisionStatus(value: unknown): DeviceProvisionResult | undefined {
  if (
    !isRecord(value) ||
    value['protocolVersion'] !== DEVICE_PROTOCOL_VERSION ||
    typeof value['deviceId'] !== 'string' ||
    !DEVICE_ID_PATTERN.test(value['deviceId']) ||
    !isRuntimeState(value['state']) ||
    typeof value['provisioned'] !== 'boolean' ||
    typeof value['wifiConnected'] !== 'boolean' ||
    typeof value['desktopReachable'] !== 'boolean' ||
    !Number.isInteger(value['configurationGeneration']) ||
    (value['configurationGeneration'] as number) < 0
  ) {
    return undefined
  }
  return {
    deviceId: value['deviceId'],
    state: value['state'],
    provisioned: value['provisioned'],
    wifiConnected: value['wifiConnected'],
    desktopReachable: value['desktopReachable'],
    configurationGeneration: value['configurationGeneration'] as number,
  }
}

function validConfigFields(value: Record<string, unknown>): boolean {
  return (
    typeof value['wifiSsid'] === 'string' &&
    typeof value['serverId'] === 'string' &&
    SERVER_ID_PATTERN.test(value['serverId']) &&
    typeof value['fallbackHost'] === 'string' &&
    Number.isInteger(value['fallbackPort']) &&
    (value['fallbackPort'] as number) >= 1 &&
    (value['fallbackPort'] as number) <= 65_535
  )
}

function isRuntimeState(value: unknown): value is DeviceProvisionRuntimeState {
  return (
    value === 'unprovisioned' ||
    value === 'applying' ||
    value === 'wifi_error' ||
    value === 'desktop_unreachable' ||
    value === 'ready'
  )
}

function validateProvisioningInput(
  request: DeviceProvisioningRequest,
  context: DeviceProvisionContext,
): void {
  const ssidBytes = Buffer.byteLength(request.wifiSsid, 'utf8')
  const passwordBytes = Buffer.byteLength(request.wifiPassword, 'utf8')
  const validPassword =
    passwordBytes === 0 ||
    (passwordBytes >= 8 && passwordBytes <= 63) ||
    (passwordBytes === 64 && /^[0-9a-f]{64}$/i.test(request.wifiPassword))
  const fallbackHost = request.fallbackHost?.trim() || context.fallbackHost?.trim()
  const fallbackPort = request.fallbackPort ?? context.fallbackPort ?? DEFAULT_DEVICE_SERVER_PORT
  if (
    !request.path ||
    !DEVICE_ID_PATTERN.test(request.deviceId) ||
    ssidBytes < 1 ||
    ssidBytes > 32 ||
    !validPassword ||
    !SERVER_ID_PATTERN.test(context.serverId) ||
    !DEVICE_TOKEN_PATTERN.test(context.deviceToken) ||
    (fallbackHost !== undefined && !validFallbackHost(fallbackHost)) ||
    !Number.isInteger(fallbackPort) ||
    fallbackPort < 1 ||
    fallbackPort > 65_535
  ) {
    throw new DeviceProvisioningFailure('invalid_input')
  }
}

function validFallbackHost(host: string): boolean {
  return (
    host.length >= 1 && host.length <= 63 && /^[A-Za-z0-9.-]+$/.test(host) && !host.includes('..')
  )
}

function normalizeFirmwareErrorCode(value: unknown): DeviceProvisioningErrorCode {
  switch (value) {
    case 'invalid_json':
    case 'invalid_request':
    case 'unsupported_protocol':
    case 'unknown_operation':
    case 'invalid_params':
    case 'line_too_long':
    case 'storage_error':
    case 'identity_error':
    case 'internal_error':
      return value
    default:
      return 'unknown'
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DeviceProvisioningFailure('cancelled'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    timer.unref?.()
    const abort = (): void => {
      clearTimeout(timer)
      reject(new DeviceProvisioningFailure('cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

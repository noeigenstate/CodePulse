import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { DeviceProvisioningRequest } from '@codepulse/shared'
import {
  Cp1Client,
  Cp1LineDecoder,
  DeviceProvisioningFailure,
  DeviceUsbManager,
  type DeviceSerialAdapter,
  type DeviceSerialConnection,
  type DeviceSerialPortInfo,
} from '../apps/desktop/src/main/device-usb.js'

const DEVICE_ID = 'codepulse-a4cb8fc3a698'
const PORT_PATH = '/dev/cu.usbmodem1101'

test('CP1 decoder handles fragmented frames and ignores logs or oversized lines', () => {
  const decoder = new Cp1LineDecoder()
  assert.deepEqual(decoder.feed(Buffer.from('boot log\nCP1 {"id":"app-1",')), [])
  assert.deepEqual(decoder.feed(Buffer.from('"ok":true,"result":{"value":1}}\r\n')), [
    { id: 'app-1', ok: true, result: { value: 1 } },
  ])
  assert.deepEqual(decoder.feed(Buffer.from(`CP1 ${'x'.repeat(1_100)}\n`)), [])
  assert.deepEqual(decoder.feed(Buffer.from('CP1 {bad json}\n')), [])
})

test('scanner probes only USB candidates and identifies devices through hello', async () => {
  const adapter = new FakeAdapter(
    [
      { path: '/dev/cu.Bluetooth-Incoming-Port' },
      { path: PORT_PATH, vendorId: '303A', productId: '1001' },
    ],
    deviceHandler(),
  )
  const manager = new DeviceUsbManager({ adapter, helloTimeoutMs: 100 })
  const devices = await manager.scanOnce()

  assert.deepEqual(adapter.openedPaths, [PORT_PATH])
  assert.equal(devices.length, 1)
  assert.equal(devices[0]?.deviceId, DEVICE_ID)
  assert.equal(devices[0]?.path, PORT_PATH)
  assert.equal(devices[0]?.config?.wifiSsid, 'Office WiFi')
  await manager.close()
})

test('scanner discovers a device that appears on a later enumeration', async () => {
  const adapter = new FakeAdapter([], deviceHandler())
  const manager = new DeviceUsbManager({ adapter, helloTimeoutMs: 100 })
  assert.deepEqual(await manager.scanOnce(), [])

  adapter.ports = [{ path: PORT_PATH, vendorId: '303a', productId: '1001' }]
  const devices = await manager.scanOnce()
  assert.equal(devices[0]?.deviceId, DEVICE_ID)
  await manager.close()
})

test('provision sends secrets only over CP1, scrubs write buffers, and succeeds only at ready', async () => {
  let statusRequests = 0
  const progress: string[] = []
  const adapter = new FakeAdapter(
    [{ path: PORT_PATH, vendorId: '303a', productId: '1001' }],
    (request) => {
      if (request.operation === 'hello') return success(request.id, helloResult(false))
      if (request.operation === 'provision') {
        assert.equal(request.params?.['wifiPassword'], 'super-secret')
        assert.equal(request.params?.['deviceToken'], 't'.repeat(64))
        return success(request.id, { saved: true, applyQueued: true })
      }
      if (request.operation === 'getStatus') {
        statusRequests += 1
        return success(request.id, statusResult(statusRequests === 1 ? 'applying' : 'ready'))
      }
      return undefined
    },
  )
  const manager = new DeviceUsbManager({
    adapter,
    helloTimeoutMs: 100,
    requestTimeoutMs: 100,
    pollIntervalMs: 1,
    provisionTimeoutMs: 1_000,
  })
  const request = provisionRequest('super-secret')
  const context = {
    serverId: '550e8400-e29b-41d4-a716-446655440000',
    deviceToken: 't'.repeat(64),
    fallbackHost: '192.168.1.20',
    fallbackPort: 17_889,
  }

  const result = await manager.provision(request, context, (next) => progress.push(next.state))

  assert.equal(result.state, 'ready')
  assert.equal(request.wifiPassword, '')
  assert.equal(context.deviceToken, '')
  assert.deepEqual(progress, ['sending', 'applying', 'ready'])
  assert.equal(
    JSON.stringify({ result, progress, devices: manager.snapshot() }).includes('super-secret'),
    false,
  )
  assert.equal(
    JSON.stringify({ result, progress, devices: manager.snapshot() }).includes('t'.repeat(64)),
    false,
  )
  for (const buffer of adapter.writtenBufferReferences) {
    assert.equal(
      buffer.every((byte) => byte === 0),
      true,
    )
  }
  await manager.close()
})

test('wifi_error is returned as a non-success terminal state', async () => {
  const adapter = new FakeAdapter(
    [{ path: PORT_PATH, vendorId: '303a', productId: '1001' }],
    (request) => {
      if (request.operation === 'hello') return success(request.id, helloResult(false))
      if (request.operation === 'provision') {
        return success(request.id, { saved: true, applyQueued: true })
      }
      if (request.operation === 'getStatus') {
        return success(request.id, statusResult('wifi_error'))
      }
      return undefined
    },
  )
  const manager = new DeviceUsbManager({
    adapter,
    helloTimeoutMs: 100,
    requestTimeoutMs: 100,
    pollIntervalMs: 1,
  })
  const result = await manager.provision(
    provisionRequest('wrong-password'),
    {
      serverId: 'server-1',
      deviceToken: 't'.repeat(32),
      fallbackHost: '192.168.1.20',
    },
    () => undefined,
  )
  assert.equal(result.state, 'wifi_error')
  assert.notEqual(result.state, 'ready')
  await manager.close()
})

test('CP1 request timeout exposes only a stable error code', async () => {
  const port = new FakePort(() => undefined)
  const client = new Cp1Client(port as unknown as DeviceSerialConnection)
  await assert.rejects(
    client.request('hello', { timeoutMs: 5 }),
    (error: unknown) =>
      error instanceof DeviceProvisioningFailure &&
      error.code === 'timeout' &&
      error.message === 'timeout',
  )
  await client.close()
})

test('invalid Wi-Fi input is rejected before the serial port opens', async () => {
  const adapter = new FakeAdapter(
    [{ path: PORT_PATH, vendorId: '303a', productId: '1001' }],
    deviceHandler(),
  )
  const manager = new DeviceUsbManager({ adapter })
  const request = provisionRequest('short')
  const context = { serverId: 'server-1', deviceToken: 't'.repeat(32) }
  await assert.rejects(
    manager.provision(request, context, () => undefined),
    (error: unknown) =>
      error instanceof DeviceProvisioningFailure && error.code === 'invalid_input',
  )
  assert.equal(request.wifiPassword, '')
  assert.equal(context.deviceToken, '')
  assert.deepEqual(adapter.openedPaths, [])
  await manager.close()
})

interface RequestFrame {
  id: string
  protocolVersion: number
  operation: string
  params?: Record<string, unknown>
}

type RequestHandler = (request: RequestFrame) => Record<string, unknown> | undefined

class FakePort extends EventEmitter {
  isOpen = true
  readonly writtenBufferReferences: Buffer[] = []

  constructor(private readonly handler: RequestHandler) {
    super()
  }

  write(data: Buffer, callback: (error?: Error | null) => void): void {
    this.writtenBufferReferences.push(data)
    const copied = Buffer.from(data).toString('utf8')
    callback()
    const request = JSON.parse(copied.slice(4)) as RequestFrame
    const response = this.handler(request)
    if (!response) return
    const encoded = Buffer.from(`CP1 ${JSON.stringify(response)}\n`, 'utf8')
    const split = Math.max(1, Math.floor(encoded.length / 2))
    queueMicrotask(() => {
      this.emit('data', encoded.subarray(0, split))
      this.emit('data', encoded.subarray(split))
    })
  }

  drain(callback: (error?: Error | null) => void): void {
    callback()
  }

  close(callback: (error?: Error | null) => void): void {
    this.isOpen = false
    callback()
  }
}

class FakeAdapter implements DeviceSerialAdapter {
  readonly openedPaths: string[] = []
  readonly writtenBufferReferences: Buffer[] = []

  constructor(
    public ports: DeviceSerialPortInfo[],
    private readonly handler: RequestHandler,
  ) {}

  async list(): Promise<DeviceSerialPortInfo[]> {
    return this.ports
  }

  async open(path: string): Promise<DeviceSerialConnection> {
    this.openedPaths.push(path)
    const port = new FakePort(this.handler)
    this.writtenBufferReferences.push(...port.writtenBufferReferences)
    // Capture references as they are written, not only at construction time.
    const originalWrite = port.write.bind(port)
    port.write = (data, callback) => {
      this.writtenBufferReferences.push(data)
      originalWrite(data, callback)
    }
    return port as unknown as DeviceSerialConnection
  }
}

function deviceHandler(): RequestHandler {
  return (request) => {
    if (request.operation === 'hello') return success(request.id, helloResult(true))
    if (request.operation === 'getConfig') {
      return success(request.id, {
        ...helloResult(true),
        wifiSsid: 'Office WiFi',
        serverId: 'server-1',
        fallbackHost: '192.168.1.20',
        fallbackPort: 17_889,
      })
    }
    return undefined
  }
}

function helloResult(provisioned: boolean): Record<string, unknown> {
  return {
    protocolVersion: 1,
    deviceId: DEVICE_ID,
    firmwareVersion: '0.0.1-bringup',
    hardwareRevision: 1,
    provisioned,
    capabilities: ['usb-provisioning-v1', 'mdns-codepulse-v1', 'mdns-display-v1'],
  }
}

function statusResult(state: 'applying' | 'wifi_error' | 'ready'): Record<string, unknown> {
  return {
    protocolVersion: 1,
    deviceId: DEVICE_ID,
    provisioned: true,
    state,
    wifiConnected: state === 'ready',
    desktopReachable: state === 'ready',
    configurationGeneration: 1,
  }
}

function success(id: string, result: Record<string, unknown>): Record<string, unknown> {
  return { id, ok: true, result }
}

function provisionRequest(password: string): DeviceProvisioningRequest {
  return {
    path: PORT_PATH,
    deviceId: DEVICE_ID,
    wifiSsid: 'Office WiFi',
    wifiPassword: password,
  }
}

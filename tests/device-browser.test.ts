import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import {
  DISPLAY_HEALTH_PATH,
  DisplayDeviceBrowser,
  type DisplayMdnsService,
} from '../apps/desktop/src/main/device-browser.js'

const DEVICE_ID = 'codepulse-a4cb8fc3a698'

test('display browser verifies TXT identity against the port 17890 health response', async () => {
  const mdns = new FakeMdns()
  const requested: string[] = []
  const browser = new DisplayDeviceBrowser({
    mdns,
    refreshMs: 60_000,
    fetch: (async (input: string | URL | Request) => {
      requested.push(String(input))
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'codepulse-display',
          protocolVersion: 1,
          deviceId: DEVICE_ID,
          firmwareVersion: '0.0.1-bringup',
          hardwareRevision: 1,
          provisioned: true,
        }),
        { status: 200 },
      )
    }) as typeof fetch,
  })
  browser.start()

  const waiting = browser.waitForDevice(DEVICE_ID, 1_000)
  mdns.browser.emit('up', displayService(DEVICE_ID))
  const device = await waiting

  assert.equal(device?.deviceId, DEVICE_ID)
  assert.equal(device?.address, '192.168.1.42')
  assert.equal(device?.port, 17_890)
  assert.deepEqual(requested, [`http://192.168.1.42:17890${DISPLAY_HEALTH_PATH}`])
  assert.equal(browser.snapshot().length, 1)

  await browser.close()
  assert.equal(mdns.browser.stopped, true)
  assert.equal(mdns.destroyed, true)
})

test('display browser rejects a service when TXT id and health deviceId differ', async () => {
  const mdns = new FakeMdns()
  const browser = new DisplayDeviceBrowser({
    mdns,
    refreshMs: 60_000,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          service: 'codepulse-display',
          protocolVersion: 1,
          deviceId: 'codepulse-ffffffffffff',
          firmwareVersion: '0.0.1',
          hardwareRevision: 1,
          provisioned: true,
        }),
        { status: 200 },
      )) as typeof fetch,
  })
  browser.start()
  mdns.browser.emit('up', displayService(DEVICE_ID))
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(browser.snapshot(), [])
  await browser.close()
})

class FakeBrowser extends EventEmitter {
  services: DisplayMdnsService[] = []
  stopped = false

  override emit(event: string, ...args: unknown[]): boolean {
    if (event === 'up' && args[0]) this.services = [args[0] as DisplayMdnsService]
    return super.emit(event, ...args)
  }

  stop(): void {
    this.stopped = true
  }

  update(): void {}

  expire(): void {}
}

class FakeMdns {
  readonly browser = new FakeBrowser()
  destroyed = false

  find(
    _options: { type: string; protocol: 'tcp' },
    onUp?: (service: DisplayMdnsService) => void,
  ): FakeBrowser {
    if (onUp) this.browser.on('up', onUp)
    return this.browser
  }

  destroy(): void {
    this.destroyed = true
  }
}

function displayService(deviceId: string): DisplayMdnsService {
  return {
    fqdn: `${deviceId}._codepulse-dsp._tcp.local`,
    host: `${deviceId}.local`,
    port: 17_890,
    addresses: ['fe80::1', '192.168.1.42'],
    txt: {
      pv: Buffer.from('1'),
      id: Buffer.from(deviceId),
      fw: Buffer.from('0.0.1-bringup'),
      hw: Buffer.from('1'),
      path: Buffer.from(DISPLAY_HEALTH_PATH),
    },
  }
}

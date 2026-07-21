import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import {
  DEVICE_MDNS_PROTOCOL,
  DEVICE_MDNS_TYPE,
  DEVICE_STATUS_PATH,
  loadOrCreateDeviceServerId,
  publishDeviceMdns,
  readDeviceServerId,
  startDeviceServer,
} from '@codepulse/local-server'

test('serverId is generated once and remains stable across launches', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codepulse-server-id-'))
  const path = join(directory, 'device-server-id')
  try {
    const initial = loadOrCreateDeviceServerId(path)
    assert.match(initial, /^[A-Za-z0-9._-]{1,64}$/)
    assert.equal(loadOrCreateDeviceServerId(path), initial)
    assert.equal(readDeviceServerId(path), initial)

    await writeFile(path, 'invalid id with spaces\n', 'utf8')
    const repaired = loadOrCreateDeviceServerId(path)
    assert.notEqual(repaired, initial)
    assert.match(repaired, /^[A-Za-z0-9._-]{1,64}$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('Desktop mDNS TXT contains only protocol, stable id and status path', async () => {
  const events: string[] = []
  const mdns = new FakeMdns(events)
  const publisher = publishDeviceMdns({
    serverId: 'stable-server-id',
    port: 17_889,
    statusPath: DEVICE_STATUS_PATH,
    mdns,
  })

  assert.deepEqual(mdns.options, {
    name: 'CodePulse-stable-s',
    type: DEVICE_MDNS_TYPE,
    protocol: DEVICE_MDNS_PROTOCOL,
    port: 17_889,
    txt: { pv: '1', id: 'stable-server-id', path: DEVICE_STATUS_PATH },
  })
  assert.equal(JSON.stringify(mdns.options).includes('token'), false)

  await publisher.close()
  await publisher.close()
  assert.deepEqual(events, ['publish', 'stop', 'destroy'])
})

test('device API advertises the actual bound port and withdraws mDNS before closing', async () => {
  const events: string[] = []
  const mdns = new FakeMdns(events)
  const server = await startDeviceServer({
    hub: new StatusHub(),
    host: '127.0.0.1',
    port: 0,
    authToken: 'd'.repeat(32),
    serverId: 'stable-server-id',
    mdns,
  })
  try {
    assert.ok(server.port > 0)
    assert.equal(mdns.options?.port, server.port)
    assert.equal(mdns.options?.txt['id'], server.serverId)
  } finally {
    await server.close()
  }
  assert.deepEqual(events, ['publish', 'stop', 'destroy'])
})

class FakeService {
  constructor(private readonly events: string[]) {}

  on(): this {
    return this
  }

  stop(callback?: () => void): void {
    this.events.push('stop')
    callback?.()
  }
}

class FakeMdns {
  options?: {
    name: string
    type: string
    protocol: 'tcp'
    port: number
    txt: Record<string, string>
  }

  constructor(private readonly events: string[]) {}

  publish(options: NonNullable<FakeMdns['options']>): FakeService {
    this.options = options
    this.events.push('publish')
    return new FakeService(this.events)
  }

  destroy(): void {
    this.events.push('destroy')
  }
}

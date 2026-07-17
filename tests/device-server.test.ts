import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import {
  DEVICE_AUTH_HEADER,
  DEVICE_HEALTH_PATH,
  DEVICE_STATUS_PATH,
  loadOrCreateDeviceAuthToken,
  readDeviceAuthToken,
  readDeviceServerConfig,
  startDeviceServer,
  type DeviceServer,
} from '@codepulse/local-server'
import { DEVICE_PROTOCOL_VERSION, type DeviceStatusV1 } from '@codepulse/shared'

const TOKEN = 'd'.repeat(32)
const openServers: DeviceServer[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()))
})

test('LAN device server is read-only, authenticated, and supports conditional GET', async () => {
  const hub = new StatusHub()
  const server = await startDeviceServer({
    hub,
    host: '127.0.0.1',
    port: 0,
    authToken: TOKEN,
  })
  openServers.push(server)

  const health = await fetch(`${server.url}${DEVICE_HEALTH_PATH}`)
  assert.equal(health.status, 200)
  const healthBody = (await health.json()) as {
    ok: boolean
    service: string
    protocolVersion: number
    ts: number
  }
  assert.equal(healthBody.ok, true)
  assert.equal(healthBody.service, 'codepulse-device')
  assert.equal(healthBody.protocolVersion, DEVICE_PROTOCOL_VERSION)
  assert.equal(typeof healthBody.ts, 'number')

  const denied = await fetch(`${server.url}${DEVICE_STATUS_PATH}`)
  assert.equal(denied.status, 401)

  const queryToken = await fetch(`${server.url}${DEVICE_STATUS_PATH}?token=${TOKEN}`)
  assert.equal(queryToken.status, 401)

  const response = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, {
    headers: { [DEVICE_AUTH_HEADER]: TOKEN },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-codepulse-protocol-version'), '1')
  const etag = response.headers.get('etag')
  assert.match(etag ?? '', /^W\/\"v1-[0-9a-f]{8}\"$/)
  const body = (await response.json()) as DeviceStatusV1
  assert.equal(body.protocolVersion, DEVICE_PROTOCOL_VERSION)
  assert.equal(body.mainState, 'idle')

  const unchanged = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, {
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'if-none-match': etag ?? '',
    },
  })
  assert.equal(unchanged.status, 304)
  assert.equal(await unchanged.text(), '')

  const writeAttempt = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, {
    method: 'POST',
    headers: { [DEVICE_AUTH_HEADER]: TOKEN },
  })
  assert.equal(writeAttempt.status, 404)
})

test('device server config is opt-in and validates its port', () => {
  assert.deepEqual(readDeviceServerConfig({}), {
    enabled: false,
    host: '0.0.0.0',
    port: 17_889,
  })
  assert.deepEqual(
    readDeviceServerConfig({
      CODEPULSE_DEVICE_SERVER_ENABLED: 'yes',
      CODEPULSE_DEVICE_SERVER_HOST: '192.168.1.20',
      CODEPULSE_DEVICE_SERVER_PORT: '18080',
      CODEPULSE_DEVICE_TOKEN: TOKEN,
    }),
    {
      enabled: true,
      host: '192.168.1.20',
      port: 18_080,
      authToken: TOKEN,
    },
  )
  assert.equal(readDeviceServerConfig({ CODEPULSE_DEVICE_SERVER_PORT: '70000' }).port, 17_889)
})

test('device auth token is persisted separately from the local Hook token', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codepulse-device-auth-'))
  const filePath = join(directory, 'device-auth')
  try {
    const created = loadOrCreateDeviceAuthToken(filePath)
    assert.equal(created.length, 64)
    assert.equal(readDeviceAuthToken(filePath), created)
    assert.equal(loadOrCreateDeviceAuthToken(filePath), created)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

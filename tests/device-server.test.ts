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
import { DEVICE_PROTOCOL_VERSION, normalizeDeviceDisplay, type DeviceStatusV1 } from '@codepulse/shared'

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
    serverId: 'device-server-test',
    publishMdns: false,
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

async function watchedServer() {
  const hub = new StatusHub()
  const server = await startDeviceServer({ hub, host: '127.0.0.1', port: 0,
    authToken: TOKEN, serverId: 'watch-test', publishMdns: false })
  openServers.push(server)
  const initial = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, { headers: { [DEVICE_AUTH_HEADER]: TOKEN } })
  const etag = initial.headers.get('etag')!
  await initial.json()
  return { hub, server, etag }
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function watch(server: DeviceServer, etag: string, wait = '1000', signal?: AbortSignal) {
  return fetch(`${server.url}${DEVICE_STATUS_PATH}`, { signal, headers: {
    [DEVICE_AUTH_HEADER]: TOKEN, 'if-none-match': etag, 'x-codepulse-wait-ms': wait,
  } })
}
test('watch returns a changed status promptly, but ignores unchanged hub events', async () => {
  const { hub, server, etag } = await watchedServer()
  let completed = false
  const pending = watch(server, etag).then(r => { completed = true; return r })
  await pause(60)
  hub.emit('status', hub.snapshot())
  await pause(60)
  assert.equal(completed, false)
  const changed = Date.now()
  hub.ingest({ id: 'watch-event', source: 'codex', externalSessionId: 'watch-session',
    eventType: 'permission_request', timestamp: changed })
  const response = await pending
  assert.equal(response.status, 200)
  assert.notEqual(response.headers.get('etag'), etag)
  assert.equal((await response.json()).mainState, 'waiting_permission')
  assert.ok(Date.now() - changed < 700, 'must wake on the event, not the 1s hold timeout')
})
test('watch times out as 304; invalid headers and unauthenticated watches are rejected', async () => {
  const { server, etag } = await watchedServer()
  const start = Date.now()
  assert.equal((await watch(server, etag, '150')).status, 304)
  assert.ok(Date.now() - start >= 120)
  for (const value of ['-1', '1001', 'NaN', '1.5'])
    assert.equal((await watch(server, etag, value)).status, 400)
  const noAuth = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, { headers: { 'x-codepulse-wait-ms': '1000', 'if-none-match': etag } })
  assert.equal(noAuth.status, 401)
})
test('aborted watches release slots; server shutdown cancels active readers and hub listener', async () => {
  const { hub, server, etag } = await watchedServer()
  for (let i = 0; i < 36; i++) {
    const abort = new AbortController()
    const pending = watch(server, etag, '1000', abort.signal).catch(() => undefined)
    await pause(5); abort.abort(); await pending
  }
  await pause(25)
  assert.equal((await watch(server, etag, '10')).status, 304)
  const pending = watch(server, etag)
  await pause(40)
  const start = Date.now()
  const closing = server.close()
  const response = await pending
  assert.equal(response.status, 503); await response.json()
  assert.equal(hub.listenerCount('status'), 0)
  assert.ok(Date.now() - start < 700, 'reader must release promptly; idle TCP keep-alive may close later')
  await closing
})
test('a stale ETag returns current data immediately even when a watch is requested', async () => {
  const { server } = await watchedServer()
  const start = Date.now()
  const response = await watch(server, 'W/"outdated"')
  assert.equal(response.status, 200); await response.json()
  assert.ok(Date.now() - start < 500)
})

test('saving a display configuration wakes the same authenticated watch without a hub event', async () => {
  const hub = new StatusHub()
  let config = normalizeDeviceDisplay({ mode: 'hud' })
  const server = await startDeviceServer({ hub, getDisplayConfig: () => config,
    host: '127.0.0.1', port: 0, authToken: TOKEN, serverId: 'config-watch', publishMdns: false })
  openServers.push(server)
  const initial = await fetch(`${server.url}${DEVICE_STATUS_PATH}`, { headers: { [DEVICE_AUTH_HEADER]: TOKEN } })
  const etag = initial.headers.get('etag')!; await initial.json()
  const pending = watch(server, etag)
  await pause(60)
  config = normalizeDeviceDisplay({ mode: 'usage' })
  const start = Date.now(); server.notifyChanged()
  const updated = await pending
  assert.equal(updated.status, 200)
  assert.equal((await updated.json()).display.mode, 'usage')
  assert.ok(Date.now() - start < 700)
})

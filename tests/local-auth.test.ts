import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { LOCAL_AUTH_HEADER, startLocalServer, type LocalServer } from '@codepulse/local-server'

const openServers: LocalServer[] = []

test.after(async () => {
  await Promise.all(openServers.map((s) => s.close()))
})

test('local server rejects unauthenticated event posts when auth is enabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-auth-'))
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const port = await freePort()
  const server = await startLocalServer({
    hub,
    host: '127.0.0.1',
    port,
    disableSessionSync: true,
    authToken: 'a'.repeat(32),
    authTokenPath: join(home, 'local-auth'),
  })
  openServers.push(server)

  try {
    const denied = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'codex',
        type: 'session_meta',
        payload: { id: 's1', cwd: 'E:/x' },
      }),
    })
    assert.equal(denied.status, 401)

    const ok = await fetch(`${server.url}/api/events`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [LOCAL_AUTH_HEADER]: 'a'.repeat(32),
      },
      body: JSON.stringify({
        source: 'codex',
        hook_event_name: 'SessionStart',
        session_id: 's1',
        cwd: 'E:/x',
      }),
    })
    assert.ok(ok.status === 202 || ok.status === 400)

    const health = await fetch(`${server.url}/api/health`)
    assert.equal(health.status, 200)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      const { port } = address
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

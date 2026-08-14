import assert from 'node:assert/strict'
import { test } from 'node:test'
import { postEvent } from '../packages/hooks/lib/post.js'

const originalFetch = globalThis.fetch
const originalCodePulseUrl = process.env.CODEPULSE_URL

function restoreGlobals() {
  globalThis.fetch = originalFetch
  if (originalCodePulseUrl === undefined) {
    delete process.env.CODEPULSE_URL
  } else {
    process.env.CODEPULSE_URL = originalCodePulseUrl
  }
}

test('postEvent retries once after a transient delivery failure', async (t) => {
  t.after(restoreGlobals)
  process.env.CODEPULSE_URL = 'http://127.0.0.1:17888'
  process.env.CODEPULSE_TOKEN = 'test-token-0123456789abcdef'
  let calls = 0
  const bodies = []
  /** @type {HeadersInit | undefined} */
  let lastHeaders

  globalThis.fetch = async (_url, init) => {
    calls += 1
    bodies.push(init?.body)
    lastHeaders = init?.headers
    if (calls === 1) throw new Error('server not ready')
    return { ok: true }
  }

  const ok = await postEvent({ source: 'codex' }, { timeoutMs: 10, retryDelayMs: 0 })

  assert.equal(ok, true)
  assert.equal(calls, 2)
  assert.equal(bodies[0], bodies[1], 'HTTP retries must preserve one delivery identity')
  const delivered = JSON.parse(String(bodies[0]))
  assert.match(delivered._codepulse_event_id, /^hook:/)
  assert.equal(typeof delivered._codepulse_timestamp, 'number')
  const headers = new Headers(lastHeaders)
  assert.equal(headers.get('x-codepulse-token'), 'test-token-0123456789abcdef')
})

test('postEvent still fails closed after retry exhaustion', async (t) => {
  t.after(restoreGlobals)
  process.env.CODEPULSE_URL = 'http://127.0.0.1:17888'
  let calls = 0

  globalThis.fetch = async () => {
    calls += 1
    throw new Error('server unavailable')
  }

  const ok = await postEvent({ source: 'codex' }, { timeoutMs: 10, retryDelayMs: 0 })

  assert.equal(ok, false)
  assert.equal(calls, 2)
})

test('postEvent applies one total deadline across all retries', async (t) => {
  t.after(restoreGlobals)
  process.env.CODEPULSE_URL = 'http://127.0.0.1:17888'
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls += 1
    await new Promise((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      void resolve
    })
    return { ok: true }
  }

  const startedAt = Date.now()
  const ok = await postEvent({ source: 'codex' }, { timeoutMs: 30, retries: 4, retryDelayMs: 20 })

  assert.equal(ok, false)
  assert.equal(calls, 1)
  assert.ok(Date.now() - startedAt < 250, 'retry deadline must not multiply hook latency')
})

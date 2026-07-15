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
  /** @type {HeadersInit | undefined} */
  let lastHeaders

  globalThis.fetch = async (_url, init) => {
    calls += 1
    lastHeaders = init?.headers
    if (calls === 1) throw new Error('server not ready')
    return { ok: true }
  }

  const ok = await postEvent({ source: 'codex' }, { timeoutMs: 10, retryDelayMs: 0 })

  assert.equal(ok, true)
  assert.equal(calls, 2)
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

import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import https from 'node:https'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'
import type { ClientRequest, IncomingMessage, RequestOptions } from 'node:http'
import { nodeTransport, type WebhookRequest } from '../src/generate/webhook.js'

function intercept(
  t: TestContext,
  protocol: typeof https | typeof http,
  options: {
    chunks?: string[]
    length?: string
    check?: (url: URL, options: RequestOptions, body: string) => void
  },
) {
  const mocked = t.mock.method(protocol, 'request', ((
    url: URL,
    requestOptions: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    const request = new EventEmitter() as ClientRequest
    request.end = ((body: string) => {
      options.check?.(url, requestOptions, body)
      queueMicrotask(() => {
        const response = new PassThrough() as unknown as IncomingMessage
        response.statusCode = 200
        response.headers = options.length ? { 'content-length': options.length } : {}
        onResponse(response)
        for (const chunk of options.chunks ?? ['{"cards":[]}'])
          (response as unknown as PassThrough).write(chunk)
        ;(response as unknown as PassThrough).end()
      })
      return request
    }) as ClientRequest['end']
    return request
  }) as typeof https.request)
  syncBuiltinESMExports()
  t.after(() => {
    mocked.mock.restore()
    syncBuiltinESMExports()
  })
}

const request = (): WebhookRequest => ({
  url: new URL('https://example.com/generate'),
  address: '93.184.216.34',
  body: '{"v":1}',
  headers: { 'Content-Type': 'application/json' },
  signal: new AbortController().signal,
})

test('Node HTTPS传输保留原URL主机名，lookup仅返回已验证地址，无真实网络', async (t) => {
  let checked = false
  intercept(t, https, {
    check(url, options, body) {
      checked = true
      assert.equal(url.hostname, 'example.com')
      assert.equal(body, '{"v":1}')
      assert.equal(options.family, 4)
      assert.equal(options.agent, false)
      const lookup = options.lookup as (
        hostname: string,
        options: object,
        callback: (error: Error | null, address: string, family: number) => void,
      ) => void
      lookup('example.com', {}, (error, address, family) => {
        assert.equal(error, null)
        assert.equal(address, '93.184.216.34')
        assert.equal(family, 4)
      })
      assert.notEqual((options as { rejectUnauthorized?: boolean }).rejectUnauthorized, false)
    },
  })
  assert.deepEqual(await nodeTransport(request()), { status: 200, body: '{"cards":[]}' })
  assert.ok(checked)
})

test('Node HTTP开发传输也固定地址', async (t) => {
  intercept(t, http, {
    check(url, options) {
      assert.equal(url.hostname, 'localhost')
      assert.equal(options.family, 4)
      assert.equal(options.agent, false)
    },
  })
  const response = await nodeTransport({
    ...request(),
    url: new URL('http://localhost:18080'),
    address: '127.0.0.1',
  })
  assert.equal(response.status, 200)
})

test('Node传输按流累计字节限制64 KiB', async (t) => {
  intercept(t, https, { chunks: ['a'.repeat(32768), 'b'.repeat(32769)] })
  await assert.rejects(nodeTransport(request()), /64 KiB/)
})

test('Node传输提前拒绝超大Content-Length', async (t) => {
  intercept(t, https, { length: '65537', chunks: [] })
  await assert.rejects(nodeTransport(request()), /64 KiB/)
})

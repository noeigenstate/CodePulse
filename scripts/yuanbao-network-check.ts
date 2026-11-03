import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { app, net, session } from 'electron'
import { YuanbaoClient } from '../apps/desktop/src/main/ambient-yuanbao.js'

const output = resolve(process.env.CODEPULSE_YUANBAO_NETWORK_OUTPUT!)
mkdirSync(resolve(output, 'profile'), { recursive: true })
app.setPath('userData', resolve(output, 'profile'))
app.commandLine.appendSwitch('no-proxy-server')
const tc3 = { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-loopback-secret' }
const apikey = { apiKey: 'obviously-fake-loopback-api-key' }
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const mac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value, 'utf8').digest()

app
  .whenReady()
  .then(async () => {
    // Even a bad endpoint regression must not send the fictitious request to Tencent.
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (request, done) => {
        done({ cancel: new URL(request.url).hostname !== '127.0.0.1' })
      },
    )
    const received: string[] = []
    let host = '',
      serverError: unknown
    const server = createServer(async (request, response) => {
      try {
        assert.equal(request.method, 'POST')
        assert.equal(request.headers.host, host, 'Chromium must generate Host from the URL')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const payload = Buffer.concat(chunks).toString('utf8')
        assert.deepEqual(JSON.parse(payload), { Query: '北京今天天气', Mode: 1 })
        if (request.headers.authorization?.startsWith('TC3-HMAC-SHA256 ')) {
          assert.equal(request.url, '/')
          assert.equal(request.headers['x-tc-action'], 'SearchPro')
          assert.equal(request.headers['x-tc-version'], '2025-05-08')
          assert.equal(request.headers['x-tc-region'], undefined)
          // Independently reconstruct the signature from the bytes and Host received on the socket.
          const timestamp = request.headers['x-tc-timestamp'] as string
          const date = new Date(Number(timestamp) * 1000).toISOString().slice(0, 10)
          const scope = `${date}/wsa/tc3_request`
          const canonical = `POST\n/\n\ncontent-type:${request.headers['content-type']}\nhost:${request.headers.host}\nx-tc-action:searchpro\n\ncontent-type;host;x-tc-action\n${sha(payload)}`
          const signingKey = mac(mac(mac('TC3' + tc3.secretKey, date), 'wsa'), 'tc3_request')
          const signature = mac(
            signingKey,
            `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${sha(canonical)}`,
          ).toString('hex')
          const expected = `TC3-HMAC-SHA256 Credential=${tc3.secretId}/${scope}, SignedHeaders=content-type;host;x-tc-action, Signature=${signature}`
          assert.equal(
            request.headers.authorization,
            expected,
            'Signature must cover the received URL host and UTF-8 bytes',
          )
          received.push('tc3')
        } else {
          assert.equal(request.url, '/SearchPro')
          assert.equal(request.headers.authorization, `Bearer ${apikey.apiKey}`)
          assert.equal(request.headers['x-tc-action'], undefined)
          received.push('apikey')
        }
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(
          JSON.stringify({
            Response: { Version: 'standard', RequestId: 'loopback-only', Pages: [] },
          }),
        )
      } catch (error) {
        serverError = error
        response.writeHead(400)
        response.end('Loopback assertion failed')
      }
    })
    server.setTimeout(5000)
    try {
      await new Promise<void>((accept, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', accept)
      })
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      host = `127.0.0.1:${address.port}`
      const client = new YuanbaoClient({
        transport: net.fetch.bind(net),
        now: () => 1793344500000,
        endpoints: { tc3: `http://${host}/`, apikey: `http://${host}/SearchPro` },
      })
      const params = { Query: '北京今天天气', Mode: 1 as const }
      await client.search(params, tc3)
      await client.search(params, apikey)
      if (serverError) throw serverError
      assert.deepEqual(received, ['tc3', 'apikey'])
      writeFileSync(
        resolve(output, 'result.json'),
        JSON.stringify(
          {
            passed: true,
            transport: 'electron.net.fetch',
            requests: 2,
            tc3: true,
            apikey: true,
            hostMatchesURL: true,
          },
          null,
          2,
        ) + '\n',
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((accept) => server.close(() => accept()))
    }
    app.exit(0)
  })
  .catch((error) => {
    console.error(
      'Yuanbao loopback network check failed:',
      error instanceof Error ? error.message : 'unknown error',
    )
    app.exit(1)
  })

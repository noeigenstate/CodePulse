import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeAmbient } from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { YuanbaoKeyStore } from '../apps/desktop/src/main/ambient-yuanbao-keys.js'
import {
  YuanbaoClient,
  yuanbaoResponseJson,
  type YuanbaoCredentials,
} from '../apps/desktop/src/main/ambient-yuanbao.js'
import { YuanbaoSource } from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'

const now = Date.parse('2026-10-30T07:33:41Z')
function temporary() {
  const root = resolve('.tmpshots/yuanbao-tests')
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(join(root, 'keys-'))
  return { directory, dispose: () => rmSync(directory, { recursive: true, force: true }) }
}
test('Yuanbao key store encrypts the credential object, preserves other providers and never returns it in snapshots', async () => {
  const f = temporary(),
    path = join(f.directory, 'ambient-keys.json'),
    encryptionKey = randomBytes(32)
  const io = {
    available: () => true,
    read: () => {
      try {
        return JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        return { x: 'existing-ciphertext' }
      }
    },
    write: (value: Record<string, unknown>) => writeFileSync(path, JSON.stringify(value)),
    encrypt: (value: string) => {
      const iv = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', encryptionKey, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decrypt: (value: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, value.subarray(0, 12))
      decipher.setAuthTag(value.subarray(12, 28))
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
  try {
    const keys = new YuanbaoKeyStore(io)
    const credential = { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-unit-secret' }
    keys.set(credential)
    const stored = readFileSync(path, 'utf8')
    assert.equal(stored.includes(credential.secretId), false)
    assert.equal(stored.includes(credential.secretKey), false)
    assert.equal(JSON.parse(stored).x, 'existing-ciphertext')
    assert.deepEqual(new YuanbaoKeyStore(io).get(), credential)
    const source = new YuanbaoSource({
      config: () => normalizeAmbient(undefined),
      credentials: () => keys.get(),
      holidays: () => ({}),
      hasYear: () => false,
      save() {},
      changed() {},
      now: () => now,
    })
    assert.equal(source.snapshot().authMode, 'tc3')
    assert.equal(JSON.stringify(source.snapshot()).includes(credential.secretId), false)
    assert.equal(JSON.stringify(source.snapshot()).includes(credential.secretKey), false)
    keys.set({ apiKey: 'definitely-fake-api-key' })
    assert.equal(source.snapshot().authMode, 'apikey')
    keys.set({})
    assert.equal(source.snapshot().hasKey, false)
    assert.equal(source.snapshot().authMode, null)
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).yuanbao, undefined)
  } finally {
    f.dispose()
  }
})
test('unavailable encryption never falls back to plaintext and persistence failures retain the previous key', () => {
  let available = false,
    fail = false,
    stored: Record<string, unknown> = {}
  const io = {
    available: () => available,
    encrypt: (value: string) => Buffer.from(value.split('').reverse().join('')),
    decrypt: (value: Buffer) => value.toString().split('').reverse().join(''),
    read: () => ({ ...stored }),
    write: (value: Record<string, unknown>) => {
      if (fail) throw Error('private failure')
      stored = value
    },
  }
  const keys = new YuanbaoKeyStore(io)
  assert.throws(() => keys.set({ apiKey: 'definitely-fake-api-key' }), /系统加密存储不可用/)
  assert.deepEqual(stored, {})
  available = true
  keys.set({ apiKey: 'definitely-fake-api-key' })
  assert.throws(() => keys.set({ secretId: 'only-one-field' }), /填写完整/)
  assert.throws(
    () => keys.set({ apiKey: 'fake', secretId: 'AKIDEXAMPLE', secretKey: 'fake' }),
    /一种/,
  )
  fail = true
  assert.throws(() => keys.set({ apiKey: 'new-fake-api-key' }), { message: '密钥未能保存' })
  assert.deepEqual(keys.get(), { apiKey: 'definitely-fake-api-key' })
})
test('response echoes, nested page strings and credential-shaped fields cannot reach snapshots or last-response files', async () => {
  const f = temporary(),
    path = join(f.directory, 'yuanbao-last-response.json')
  const credential = { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-unit-"secret' }
  const raw = JSON.parse(
    readFileSync('tests/fixtures/yuanbao/yuanbao-weather-m1.json', 'utf8'),
  ).response
  raw.echo = {
    secretId: credential.secretId,
    secretKey: credential.secretKey,
    Authorization: `Bearer ${credential.secretKey}`,
  }
  raw.Response.Pages.push(
    JSON.stringify({
      title: credential.secretKey,
      site: credential.secretId,
      passage: 'echo ' + credential.secretKey,
    }),
  )
  const client = new YuanbaoClient({
    now: () => now,
    transport: async () => new Response(JSON.stringify(raw)),
  })
  const config = normalizeAmbient({ yuanbao: { enabled: false } })
  let cache: unknown
  const source = new YuanbaoSource({
    config: () => config,
    credentials: () => credential,
    client,
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save: (value) => {
      cache = value
    },
    saveLastResponse: (value) => writeFileSync(path, yuanbaoResponseJson(value)),
    changed() {},
  })
  try {
    const result = await source.test()
    assert.equal(result.ok, true)
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const all = JSON.stringify({ snapshot: source.snapshot(), cards: source.cards(), cache, saved })
    assert.equal(all.includes(credential.secretId), false)
    assert.equal(all.includes(credential.secretKey), false)
    assert.equal(all.includes(JSON.stringify(credential.secretKey).slice(1, -1)), false)
    assert.equal(saved.Response.RequestId, raw.Response.RequestId)
    assert.equal(saved.Response.Pages.length, raw.Response.Pages.length)
    assert.equal(saved.Response.Version, 'standard')
  } finally {
    f.dispose()
  }
})
test('failed test responses are recorded without credentials and expose only the fixed error', async () => {
  const key = { apiKey: 'definitely-fake-api-key' },
    config = normalizeAmbient(undefined)
  let saved: unknown
  const source = new YuanbaoSource({
    config: () => config,
    credentials: () => key,
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    client: new YuanbaoClient({
      now: () => now,
      transport: async () =>
        new Response(
          JSON.stringify({
            Response: {
              Version: 'lite',
              RequestId: 'test-only-id',
              Error: { Code: 'AuthFailure.InvalidSecretId', Message: key.apiKey },
              Authorization: key.apiKey,
            },
          }),
        ),
    }),
    saveLastResponse: (raw) => {
      saved = raw
    },
  })
  const result = await source.test()
  assert.equal(result.error, '密钥错误')
  assert.equal(source.snapshot().requestsToday, 1)
  assert.equal(source.snapshot().edition, 'lite')
  assert.equal(JSON.stringify(saved).includes(key.apiKey), false)
  assert.equal(JSON.stringify(source.snapshot()).includes(key.apiKey), false)
})
test('sample IPC uses the production text projection without a key, network, quota or task mutation', async () => {
  let sends = 0
  const hub = new StatusHub(),
    before = JSON.stringify(hub.snapshot().agents)
  const service = new AmbientService({
    config: {},
    status: () => hub.snapshot(),
    key: () => '',
    save() {},
    changed() {},
    request: async () => {
      sends++
      throw Error('not allowed')
    },
    image: async () => '',
  })
  const handlers = new Map<string, (...args: any[]) => any>()
  registerAmbientIpc(
    {
      handle: (name, callback) => {
        handlers.set(name, callback)
      },
    },
    { service } as any,
    () => toDeviceStatusV1(hub.snapshot()),
    async () => {},
  )
  for (const topic of ['weather', 'gold', 'stock', 'tools', 'holiday', 'news']) {
    const preview = await handlers.get('codepulse:yuanbao-sample')!({}, topic)
    assert.ok(preview.ambient.source.endsWith('· 示例'))
    assert.equal(preview.mainState, 'idle')
  }
  assert.throws(() => handlers.get('codepulse:yuanbao-sample')!({}, 'invalid'), /示例类型/)
  assert.equal(sends, 0)
  assert.equal(service.snapshot().yuanbao!.requestsToday, 0)
  assert.equal(JSON.stringify(hub.snapshot().agents), before)
})
test('clearing credentials while a request is in flight cannot install its returned cards', async () => {
  let key: YuanbaoCredentials | null = { apiKey: 'definitely-fake-api-key' },
    release: (value: Response) => void = () => {},
    sent = false
  const client = new YuanbaoClient({
    now: () => now,
    transport: () => {
      sent = true
      return new Promise((resolve) => {
        release = resolve
      })
    },
  })
  const source = new YuanbaoSource({
    config: () => normalizeAmbient({ yuanbao: { enabled: true, weatherEnabled: true } }),
    credentials: () => key,
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    client,
  })
  const pending = source.test()
  for (let i = 0; i < 10 && !sent; i++) await Promise.resolve()
  assert.equal(sent, true)
  key = null
  source.credentialsChanged()
  release(
    new Response(
      JSON.stringify(
        JSON.parse(readFileSync('tests/fixtures/yuanbao/yuanbao-weather-m1.json', 'utf8')).response,
      ),
    ),
  )
  await pending
  assert.equal(source.cards().length, 0)
  assert.equal(source.snapshot().hasKey, false)
  assert.equal(source.snapshot().requestsToday, 1)
})

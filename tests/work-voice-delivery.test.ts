import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Fastify from 'fastify'
import { DEFAULT_WORK_VOICE } from '@codepulse/shared'
import { WorkVoiceDelivery } from '../apps/desktop/src/main/work-voice-delivery.js'
import { registerWorkVoiceRoutes } from '../apps/desktop/src/main/work-voice-http.js'
import { registerDeviceAuthGuard } from '../packages/local-server/src/device-auth.js'
import {
  readWorkVoiceTargets,
  writeWorkVoiceTarget,
} from '../apps/desktop/src/main/work-voice-settings.js'

test('desktop preference migrates without enabling e-paper; independent updates preserve the other output', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-outputs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'settings.json')
  writeFileSync(path, JSON.stringify({ ...DEFAULT_WORK_VOICE, enabled: true }))
  assert.equal(readWorkVoiceTargets(path).desktop.enabled, true)
  assert.equal(readWorkVoiceTargets(path).ink.enabled, false)
  writeWorkVoiceTarget(path, 'ink', { ...DEFAULT_WORK_VOICE, enabled: true, failures: false })
  writeWorkVoiceTarget(path, 'desktop', DEFAULT_WORK_VOICE)
  assert.equal(readWorkVoiceTargets(path).desktop.enabled, false)
  assert.equal(readWorkVoiceTargets(path).ink.enabled, true)
  assert.equal(readWorkVoiceTargets(path).ink.failures, false)
})

test('device delivery needs a claim and playback attempt; each device acknowledges independently', async () => {
  const pcm = new Uint8Array(3200)
  const delivery = new WorkVoiceDelivery(async () => pcm)
  delivery.publish('fixed phrase', 'en', () => true)
  const a = delivery.claim('device-a')!
  assert.equal(delivery.available(), true)
  await assert.rejects(delivery.audio('unknown', a.id))
  assert.throws(() => delivery.acknowledge('device-a', a.id))
  assert.deepEqual(await delivery.audio('device-a', a.id), pcm)
  delivery.acknowledge('device-a', a.id)
  assert.equal(delivery.claim('device-a'), null)
  const b = delivery.claim('device-b')!
  assert.equal(b.id, a.id)
  assert.deepEqual(await delivery.audio('device-b', b.id), pcm)
})

test('resolved/expired/disabled delivery and in-flight cancellation cannot return stale audio', async () => {
  let now = 0,
    relevant = true,
    release!: (value: Uint8Array) => void
  const delivery = new WorkVoiceDelivery(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
    () => {},
    () => now,
  )
  delivery.publish('test', 'zh', () => relevant)
  const item = delivery.claim('a')!
  const reading = delivery.audio('a', item.id)
  relevant = false
  release(new Uint8Array(3200))
  await assert.rejects(reading)
  assert.equal(delivery.claim('a'), null)
  delivery.publish('test', 'en', () => true)
  now = 120001
  assert.equal(delivery.claim('a'), null)
  assert.equal(delivery.available(), true)
  now += 31000
  assert.equal(delivery.available(), false)
  delivery.publish('test', 'en', () => true)
  const next = delivery.claim('a')!
  const reading2 = delivery.audio('a', next.id)
  delivery.clear()
  release(new Uint8Array(3200))
  await assert.rejects(reading2)
})

test('failed synthesis is bounded to three delivery attempts and caches the failure', async () => {
  let attempts = 0
  const delivery = new WorkVoiceDelivery(async () => {
    attempts++
    throw Error('unavailable')
  })
  delivery.publish('test', 'en', () => true)
  const item = delivery.claim('a')!
  for (let i = 0; i < 3; i++) await assert.rejects(delivery.audio('a', item.id))
  assert.equal(attempts, 1)
  assert.equal(delivery.error, 'failed')
  assert.equal(delivery.claim('a'), null)
  for (let i = 0; i < 15; i++) delivery.claim('other-' + i)
  assert.throws(() => delivery.claim('overflow'))
})

test('work voice LAN endpoints remain authenticated, bounded and independent of assistant speech', async (t) => {
  const app = Fastify(),
    token = 'fixture-work-voice-token-0123456789'
  t.after(() => app.close())
  registerDeviceAuthGuard(app, token)
  const delivery = new WorkVoiceDelivery(async () => new Uint8Array(3200))
  registerWorkVoiceRoutes(app, delivery)
  const url = '/api/v1/device/work/voice',
    headers = { 'x-codepulse-device-token': token, 'x-codepulse-device-id': 'test-a' }
  assert.equal((await app.inject({ url })).statusCode, 401)
  assert.equal((await app.inject({ url, headers })).json().announcement, null)
  delivery.publish('fixed phrase', 'en', () => true)
  const id = (await app.inject({ url, headers })).json().announcement.id
  const audio = await app.inject({ url: url + '/' + id + '/audio', headers })
  assert.equal(audio.statusCode, 200)
  assert.equal(audio.rawPayload.length, 3200)
  assert.equal(audio.headers['x-codepulse-audio-rate'], '16000')
  assert.equal(
    (await app.inject({ url: url + '/' + id + '/ack', method: 'POST', headers, payload: {} }))
      .statusCode,
    200,
  )
  assert.equal((await app.inject({ url, headers })).json().announcement, null)
  assert.equal((await app.inject({ url: url + '/' + id + '/audio', headers })).statusCode, 410)
})

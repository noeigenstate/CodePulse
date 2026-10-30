import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { AssistantStore } from '../apps/desktop/src/main/assistant-store.js'
import { AssistantService } from '../apps/desktop/src/main/assistant-service.js'
import { LumaAssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { registerAssistantRoutes } from '../apps/desktop/src/main/assistant-http.js'
import { registerDeviceAuthGuard } from '../packages/local-server/src/device-auth.js'

test('assistant LAN endpoints require the existing device credential, including audio bodies', async () => {
  const app = Fastify(),
    store = new AssistantStore(':memory:'),
    keys = { llmKey: '', speechAppKey: '', speechToken: '' }
  const service = new AssistantService({
    store,
    keys: () => keys,
    provider: new LumaAssistantProvider(() => keys),
    changed: () => {},
    save: () => {},
    notify: () => true,
  })
  registerDeviceAuthGuard(app, 'test-token-at-least-sixteen')
  registerAssistantRoutes(app, service)
  try {
    for (const path of ['/info', '/text', '/speech', '/voice']) {
      const result = await app.inject({
        method: path === '/info' ? 'GET' : 'POST',
        url: '/api/v1/device/assistant' + path,
        payload: path === '/info' ? undefined : { text: '待办：喝水' },
      })
      assert.equal(result.statusCode, 401)
    }
    assert.equal(store.list().length, 0)
    const query = await app.inject({
      url: '/api/v1/device/assistant/info?token=test-token-at-least-sixteen',
    })
    assert.equal(query.statusCode, 401)
  } finally {
    service.stop()
    store.close()
    await app.close()
  }
})
test('device confirmation is scoped to the authenticated device and cannot forge an action', async () => {
  const app = Fastify(),
    store = new AssistantStore(':memory:'),
    keys = { llmKey: '', speechAppKey: '', speechToken: '' }
  const service = new AssistantService({
    store,
    keys: () => keys,
    provider: new LumaAssistantProvider(() => keys),
    changed: () => {},
    save: () => {},
    notify: () => true,
  })
  registerDeviceAuthGuard(app, 'test-token-at-least-sixteen')
  registerAssistantRoutes(app, service)
  const headers = {
    'x-codepulse-device-token': 'test-token-at-least-sixteen',
    'x-codepulse-device-id': 'test-device',
  }
  try {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/device/assistant/text',
      headers,
      payload: { text: '10分钟后提醒我喝水' },
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().needsConfirmation, true)
    assert.equal(store.list().length, 0)
    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/device/assistant/text',
      headers: { ...headers, 'x-codepulse-device-id': 'another-device' },
      payload: { text: '确认' },
    })
    assert.equal(other.statusCode, 400)
    assert.equal(store.list().length, 0)
    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/device/assistant/text',
      headers,
      payload: { text: '确认' },
    })
    assert.equal(confirm.statusCode, 200)
    assert.equal(store.list().length, 1)
    const disabledAudio = await app.inject({
      method: 'POST',
      url: '/api/v1/device/assistant/voice',
      headers: { ...headers, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(3200),
    })
    assert.equal(disabledAudio.statusCode, 400)
    assert.match(disabledAudio.json().error, /开启语音输入/)
  } finally {
    service.stop()
    store.close()
    await app.close()
  }
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { LumaAssistantProvider } from '../apps/desktop/src/main/assistant-provider.js'
import { DEFAULT_ASSISTANT_SETTINGS } from '@codepulse/shared'

function provider(response: () => Response) {
  return new LumaAssistantProvider(
    () => ({ llmKey: 'fixture-not-a-real-key', speechAppKey: '', speechToken: '' }),
    async () => response(),
  )
}
test('free-tier exhaustion explains the model quota without leaking upstream error text', async () => {
  const p = provider(() =>
    Response.json(
      {
        code: 'AllocationQuota.FreeTierOnly',
        message: 'PRIVATE_UPSTREAM_TEXT',
        request_id: 'PRIVATE_REQUEST_ID',
      },
      { status: 403 },
    ),
  )
  await assert.rejects(
    () => p.plan('合成输入', DEFAULT_ASSISTANT_SETTINGS, [], [], Date.now()),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /当前模型的免费额度已用完/)
      assert.ok(!error.message.includes('PRIVATE'))
      return true
    },
  )
})
test('oversized upstream error bodies are bounded and never become a UI message', async () => {
  const p = provider(() => new Response('PRIVATE'.repeat(10000), { status: 403 }))
  await assert.rejects(
    () => p.plan('合成输入', DEFAULT_ASSISTANT_SETTINGS, [], [], Date.now()),
    (error) => error instanceof Error && error.message === '服务请求失败，请检查密钥、额度或网络',
  )
})

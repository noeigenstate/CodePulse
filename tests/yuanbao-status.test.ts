import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  syncAuthMode,
  yuanbaoRowError,
} from '../apps/desktop/src/renderer/src/lib/yuanbaoStatus.js'

test('each row shows only its own topics error', () => {
  const errors = { weather: '密钥错误', tools: '限流，稍后再试', news: '连接失败' }
  assert.equal(yuanbaoRowError('life', errors), '密钥错误')
  assert.equal(yuanbaoRowError('tools', errors), '限流，稍后再试')
  assert.equal(yuanbaoRowError('headlines', errors), '连接失败')
  assert.equal(yuanbaoRowError('holiday', errors), '', 'a row without an error stays clean')
})

test('生活卡 covers weather, gold and stock, in that order', () => {
  assert.equal(yuanbaoRowError('life', { stock: '参数不被当前版本支持' }), '参数不被当前版本支持')
  assert.equal(
    yuanbaoRowError('life', { gold: '未开通或额度用完', stock: '连接失败' }),
    '未开通或额度用完',
  )
  assert.equal(
    yuanbaoRowError('life', { tools: '连接失败', holiday: '连接失败', news: '连接失败' }),
    '',
    'other topics never leak into 生活卡',
  )
})

test('a missing or blank error map falls back to nothing', () => {
  assert.equal(yuanbaoRowError('life', undefined), '')
  assert.equal(yuanbaoRowError('tools', {}), '')
  assert.equal(yuanbaoRowError('tools', { tools: '   ' }), '')
})

test('the auth mode follows the host until the user touches the switch', () => {
  assert.equal(syncAuthMode('tc3', false, 'apikey'), 'apikey', 'first snapshot of an API-key user')
  assert.equal(syncAuthMode('tc3', false, undefined), 'tc3', 'no snapshot yet')
  assert.equal(syncAuthMode('apikey', false, null), 'apikey', 'a cleared key keeps the shown mode')
  assert.equal(syncAuthMode('apikey', false, 'tc3'), 'tc3', 'the host mode changed while untouched')
  assert.equal(syncAuthMode('tc3', true, 'apikey'), 'tc3', 'a touched switch is never overridden')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeDeviceDisplay, deviceGridColumns } from '@codepulse/shared'
import { createDeviceDensityPreview } from '../apps/desktop/src/renderer/src/components/device-density-preview.js'

test('3/6/9 previews have unique identities, long titles and an attention state in each column', () => {
  const config = normalizeDeviceDisplay({})
  const original = structuredClone(config)
  for (const count of [3, 6, 9] as const) {
    const data = createDeviceDensityPreview(config, count)
    assert.equal(data.threadTotal, count)
    assert.equal(data.threads!.length, count)
    assert.equal(new Set(data.threads!.map(t => t.id)).size, count)
    assert.equal(deviceGridColumns(count), count / 3)
    for (let col = 0; col < count / 3; col++) {
      assert.equal(data.threads![col * 3]!.state, 'waiting_permission')
    }
    for (const row of data.threads!) {
      assert.ok(Buffer.byteLength(row.title) <= 96)
      assert.ok(row.title.length > 10)
    }
    assert.deepEqual(config, original)
    assert.deepEqual(createDeviceDensityPreview(config, count), data)
  }
})

test('preview options remain local; provider filters and metric match the selected draft', () => {
  const config = normalizeDeviceDisplay({ agents: ['claude_code'], page: 8, metric: 'used', showQuota: false, showEnvironment: false })
  const sample = createDeviceDensityPreview(config, 9)
  assert.equal(sample.display!.page, 0)
  assert.equal(config.page, 8)
  assert.equal(sample.display!.metric, 'used')
  assert.equal(sample.display!.showQuota, false)
  assert.equal(sample.display!.showEnvironment, false)
  assert.ok(sample.threads!.every(t => t.type === 'claude_code'))
  assert.equal(createDeviceDensityPreview(normalizeDeviceDisplay({ agents: [] }), 6).threadTotal, 0)
})

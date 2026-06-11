import assert from 'node:assert/strict'
import { test } from 'node:test'
import { snapshotDataKey } from '../apps/desktop/src/renderer/src/lib/snapshotKey.js'

test('snapshotDataKey ignores updatedAt-only polling changes', () => {
  const first = {
    overall: 'running' as const,
    updatedAt: 100,
    agents: [
      {
        agentType: 'codex' as const,
        state: 'THINKING' as const,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'thinking',
        lastEventAt: 50,
        unread: false,
      },
    ],
  }
  const second = { ...first, updatedAt: 200 }

  assert.equal(snapshotDataKey(first), snapshotDataKey(second))
})

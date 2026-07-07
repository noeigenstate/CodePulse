import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  openDb,
  persistEvent,
  pruneEventsBefore,
  recentEvents,
  tokenSnapshots,
} from '@codepulse/storage'

test('pruneEventsBefore deletes old raw events and token snapshots', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-storage-prune-'))
  let opened: ReturnType<typeof openDb>
  try {
    opened = openDb(join(home, 'codepulse.sqlite'))
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    if (isNativeSqliteAbiMismatch(error)) {
      t.skip('better-sqlite3 native module is built for a different runtime')
      return
    }
    throw error
  }
  const { db, sqlite } = opened

  try {
    persistEvent(db, {
      id: 'old-token',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      timestamp: 1_000,
      token: { input: 10, total: 10, accuracy: 'exact' },
    })
    persistEvent(db, {
      id: 'new-token',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'session-a',
      cwd: 'E:/project/a',
      timestamp: 3_000,
      token: { input: 20, total: 20, accuracy: 'exact' },
    })

    pruneEventsBefore(db, 2_000)

    assert.deepEqual(
      recentEvents(db).map((event) => event.id),
      ['new-token'],
    )
    assert.deepEqual(
      db
        .select()
        .from(tokenSnapshots)
        .all()
        .map((snapshot) => snapshot.inputTokens),
      [20],
    )
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

function isNativeSqliteAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('NODE_MODULE_VERSION') || message.includes('ERR_DLOPEN_FAILED')
}

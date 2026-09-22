import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpencodeSessions } from '../packages/local-server/src/opencode-db.js'

/** Builds a minimal OpenCode session database fixture. */
async function makeFixtureDb(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-opencode-db-'))
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(join(home, 'opencode.db'))
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT, directory TEXT, model TEXT,
      tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER,
      time_created INTEGER, time_updated INTEGER
    );
    CREATE TABLE session_message (
      id TEXT, session_id TEXT, type TEXT, seq INTEGER,
      time_created INTEGER, time_updated INTEGER, data TEXT
    );
  `)
  const now = Date.now()
  db.prepare(`INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    'ses_ctx',
    'E:/work/ctx',
    '{"id":"mimo-v2.6-pro","providerID":"xiaomi-token-plan-cn"}',
    12_000,
    3_200,
    800,
    48_000,
    0,
    now - 60_000,
    now - 30_000,
  )
  const insert = db.prepare(`INSERT INTO session_message VALUES (?,?,?,?,?,?,?)`)
  // Completed message with the last request's context footprint.
  insert.run(
    'msg_1',
    'ses_ctx',
    'assistant',
    2,
    now - 20_000,
    now - 5_000,
    JSON.stringify({
      tokens: { input: 4_200, output: 300, reasoning: 120, cache: { read: 500_000, write: 0 } },
    }),
  )
  // A newer streaming row without tokens must not hide the completed one.
  insert.run(
    'msg_2',
    'ses_ctx',
    'assistant',
    3,
    now - 1_000,
    now - 1_000,
    JSON.stringify({ content: [], agent: 'build' }),
  )
  db.close()
  return home
}

test('readOpencodeSessions maps tokens, model id, and context usage', async () => {
  const home = await makeFixtureDb()
  try {
    const [snapshot] = readOpencodeSessions(home)
    assert.ok(snapshot)
    assert.equal(snapshot.sessionId, 'ses_ctx')
    assert.equal(snapshot.model, 'mimo-v2.6-pro')
    assert.equal(snapshot.token?.input, 12_000)
    assert.equal(snapshot.token?.cachedInput, 48_000)
    assert.equal(snapshot.token?.total, 63_200)

    // Context footprint = fresh input + cache read/write = 504,200 of 1M.
    assert.equal(snapshot.token?.contextWindow, 1_048_576)
    assert.ok(Math.abs((snapshot.token?.contextUsedPercent ?? 0) - 48.08) < 0.01)

    // Liveness prefers the streaming message write time over the session row.
    assert.ok(snapshot.mtimeMs >= Date.now() - 2_000)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

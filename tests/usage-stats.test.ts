import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDb, persistEvent, queryUsageStats } from '@codepulse/storage'

test('queryUsageStats aggregates tokens, turns, and projects from SQLite', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-stats-'))
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
  const now = Date.parse('2026-06-07T12:00:00')
  const day = 24 * 60 * 60_000

  try {
    // Day 1 — project A
    persistEvent(db, {
      id: 'e1',
      source: 'codex',
      eventType: 'prompt_submit',
      externalSessionId: 's1',
      workspacePath: 'E:/work/gitlab_single_pipe',
      model: 'gpt-4o',
      timestamp: now - 2 * day,
    })
    persistEvent(db, {
      id: 'e2',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 's1',
      workspacePath: 'E:/work/gitlab_single_pipe',
      model: 'gpt-4o',
      timestamp: now - 2 * day + 60_000,
      token: { input: 1000, output: 500, total: 1500, accuracy: 'estimated' },
    })
    persistEvent(db, {
      id: 'e3',
      source: 'codex',
      eventType: 'turn_stop',
      externalSessionId: 's1',
      workspacePath: 'E:/work/gitlab_single_pipe',
      timestamp: now - 2 * day + 120_000,
    })

    // Day 2 — project B, Claude
    persistEvent(db, {
      id: 'e4',
      source: 'claude_code',
      eventType: 'prompt_submit',
      externalSessionId: 's2',
      workspacePath: 'E:/work/flow_pattern_classifier',
      model: 'claude-3-5-sonnet',
      timestamp: now - day,
    })
    persistEvent(db, {
      id: 'e5',
      source: 'claude_code',
      eventType: 'token_snapshot',
      externalSessionId: 's2',
      workspacePath: 'E:/work/flow_pattern_classifier',
      model: 'claude-3-5-sonnet',
      timestamp: now - day + 30_000,
      token: { input: 8000, output: 2000, total: 10_000, accuracy: 'exact' },
    })
    persistEvent(db, {
      id: 'e6',
      source: 'claude_code',
      eventType: 'turn_stop',
      externalSessionId: 's2',
      workspacePath: 'E:/work/flow_pattern_classifier',
      timestamp: now - day + 90_000,
    })

    const stats = queryUsageStats(db, { range: '7d' }, now, { dbPath: join(home, 'codepulse.sqlite') })

    assert.equal(stats.hasData, true)
    assert.equal(stats.persistenceAvailable, true)
    assert.ok(stats.kpis.totalTokens >= 11_500)
    assert.equal(stats.kpis.projectCount, 2)
    assert.equal(stats.kpis.dialogCount, 2)
    assert.ok(stats.kpis.totalDurationMs > 0)
    assert.ok(stats.tokenTrend.length >= 7)
    assert.ok(stats.models.length >= 1)
    assert.ok(stats.projectRank.length === 2)
    assert.ok(stats.heatmap.length === 7 * 24)
    assert.ok(stats.efficiency.score >= 0)
    assert.ok(stats.insights.length >= 1)
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('queryUsageStats returns empty snapshot without db', () => {
  const stats = queryUsageStats(null, { range: 'today' }, Date.now(), {
    dbPath: 'C:/tmp/codepulse.sqlite',
    openError: 'native module missing',
  })
  assert.equal(stats.hasData, false)
  assert.equal(stats.persistenceAvailable, false)
  assert.equal(stats.dbPath, 'C:/tmp/codepulse.sqlite')
  assert.match(String(stats.persistenceError), /native module missing|SQLite unavailable/)
  assert.equal(stats.kpis.totalTokens, 0)
  assert.equal(stats.projectRank.length, 0)
})

function isNativeSqliteAbiMismatch(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('NODE_MODULE_VERSION') || message.includes('ERR_DLOPEN_FAILED')
}

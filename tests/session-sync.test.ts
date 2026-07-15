import assert from 'node:assert/strict'
import { mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { SessionSyncService } from '@codepulse/local-server'

test('SessionSyncService hydrates Codex project from local rollout within one scan', async () => {
  const home = await mkdtempJoin('codepulse-session-sync-')
  const sessions = join(home, 'sessions', '2026', '07', '14')
  const sessionId = '019f7000-aaaa-bbbb-cccc-ddddeeeeffff'
  const cwd = 'E:/work/background-task'
  const rollout = join(sessions, `rollout-2026-07-14T12-00-00-${sessionId}.jsonl`)
  const futureReset = Math.floor(Date.now() / 1000) + 86_400

  await mkdir(sessions, { recursive: true })
  await writeFile(
    rollout,
    [
      JSON.stringify({
        type: 'session_meta',
        payload: { id: sessionId, cwd, model: 'gpt-5.3-codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            model_context_window: 256000,
            last_token_usage: { input_tokens: 51200, output_tokens: 100, total_tokens: 51300 },
          },
          rate_limits: {
            limit_id: 'codex',
            primary: {
              used_percent: 37,
              window_minutes: 10080,
              resets_at: futureReset,
            },
          },
        },
      }),
    ].join('\n'),
    'utf8',
  )
  // Ensure mtime is "recent"
  const now = new Date()
  await utimes(rollout, now, now)

  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const sync = new SessionSyncService({ hub, codexHome: home, grokHome: join(home, 'no-grok') })

  try {
    await sync.syncNow()
    const codex = hub.snapshot().agents.find((a) => a.agentType === 'codex')
    assert.ok(codex, 'expected codex agent after disk sync')
    assert.equal(codex?.workspacePath?.replace(/\\/g, '/'), cwd.replace(/\\/g, '/'))
    assert.ok(
      (codex?.token?.contextUsedPercent ?? 0) > 15,
      `expected context % from last_token_usage, got ${codex?.token?.contextUsedPercent}`,
    )
    assert.equal(codex?.token?.rateLimits?.sevenDay?.usedPercent, 37)
    assert.equal(codex?.model, 'gpt-5.3-codex')
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

async function mkdtempJoin(prefix: string): Promise<string> {
  const { mkdtemp } = await import('node:fs/promises')
  return mkdtemp(join(tmpdir(), prefix))
}

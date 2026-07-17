import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readLatestKimiUsage } from '../packages/hooks/lib/kimi-usage.js'

/** Creates one representative Kimi session for usage-reader tests. */
async function createSession(home, sessionId, cwd) {
  const sessionDir = join(home, 'sessions', 'wd_demo', sessionId)
  const agentDir = join(sessionDir, 'agents', 'main')
  await mkdir(agentDir, { recursive: true })
  await writeFile(
    join(home, 'session_index.jsonl'),
    `${JSON.stringify({ sessionId, sessionDir, workDir: cwd })}\n`,
    'utf8',
  )
  await writeFile(
    join(agentDir, 'wire.jsonl'),
    [
      JSON.stringify({
        type: 'llm.request',
        modelAlias: 'kimi-code/k3',
        thinkingEffort: 'max',
        maxTokens: 227_500,
      }),
      JSON.stringify({
        type: 'usage.record',
        model: 'kimi-code/k3',
        usage: { inputOther: 2_000, inputCacheRead: 30_000, inputCacheCreation: 500, output: 700 },
      }),
    ].join('\n'),
    'utf8',
  )
  return sessionDir
}

test('Kimi usage reader extracts model, thinking depth, tokens, and context', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-usage-'))
  try {
    const sessionId = 'session_test'
    await createSession(home, sessionId, 'E:/work/kimi')
    const usage = await readLatestKimiUsage({ session_id: sessionId }, { kimiHome: home })

    assert.equal(usage.model, 'kimi-code/k3')
    assert.equal(usage.thinking_effort, 'max')
    assert.equal(usage.usage.input_tokens, 32_500)
    assert.equal(usage.usage.cached_input_tokens, 30_000)
    assert.equal(usage.usage.output_tokens, 700)
    assert.equal(usage.context_window_size, 260_000)
    assert.equal(usage.context_used_percent, 12.5)
    assert.match(usage.usage_source_path, /wire\.jsonl$/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Kimi usage reader resolves by cwd and returns empty data when absent', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-kimi-cwd-'))
  try {
    await createSession(home, 'session_cwd', 'E:\\work\\kimi-cwd')
    const usage = await readLatestKimiUsage({ cwd: 'e:/work/kimi-cwd/' }, { kimiHome: home })
    assert.equal(usage.model, 'kimi-code/k3')
    assert.deepEqual(await readLatestKimiUsage({}, { kimiHome: join(home, 'missing') }), {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

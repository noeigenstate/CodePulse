import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findModelPrice, priceRequest } from '@codepulse/shared'
import { queryUsageLedger, UsageScanner } from '@codepulse/storage'

type Sqlite = import('better-sqlite3').Database

async function fixture(): Promise<{ home: string; claude: string; codex: string; sqlite: Sqlite }> {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-ledger-'))
  const claude = join(home, 'claude', 'projects')
  const codex = join(home, 'codex', 'sessions')
  await mkdir(join(claude, 'C--work-app'), { recursive: true })
  await mkdir(join(codex, '2026', '09', '30'), { recursive: true })
  const Database = (await import('better-sqlite3')).default
  return { home, claude, codex, sqlite: new Database(join(home, 'ledger.sqlite')) }
}

const NOW = Date.now()
const iso = (offsetMs: number): string => new Date(NOW - offsetMs).toISOString()
const line = (value: unknown): string => `${JSON.stringify(value)}\n`

function claudeAssistant(
  id: string,
  requestId: string,
  offsetMs: number,
  model = 'claude-opus-5-5',
): string {
  return line({
    type: 'assistant',
    uuid: `u-${id}-${Math.random()}`,
    sessionId: 'sess-1',
    requestId,
    timestamp: iso(offsetMs),
    cwd: 'C:\\work\\app',
    message: {
      id,
      model,
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 3_000,
        cache_creation: { ephemeral_5m_input_tokens: 1_000, ephemeral_1h_input_tokens: 2_000 },
      },
    },
  })
}

function claudeUser(uuid: string, content: unknown, offsetMs: number, extra: object = {}): string {
  return line({
    type: 'user',
    uuid,
    sessionId: 'sess-1',
    timestamp: iso(offsetMs),
    cwd: 'C:\\work\\app',
    message: { role: 'user', content },
    ...extra,
  })
}

test('Claude transcripts: one row per API request, typed prompts only, exact cost', async () => {
  const { home, claude, codex, sqlite } = await fixture()
  try {
    const file = join(claude, 'C--work-app', 'sess-1.jsonl')
    await writeFile(
      file,
      [
        claudeUser('p1', 'fix the login bug', 60_000),
        // Streaming writes one line per content block with identical usage.
        claudeAssistant('msg_1', 'req_1', 59_000),
        claudeAssistant('msg_1', 'req_1', 59_000),
        claudeUser('t1', [{ type: 'tool_result', content: 'ok' }], 58_000, { toolUseResult: {} }),
        claudeAssistant('msg_2', 'req_2', 57_000),
        claudeUser('m1', 'Caveat: meta', 56_000, { isMeta: true }),
        claudeUser('n1', '<task-notification>\n<task-id>x</task-id>', 55_000),
        line({
          type: 'attachment',
          uuid: 'q-row',
          sessionId: 'sess-1',
          timestamp: iso(54_000),
          cwd: 'C:\\work\\app',
          attachment: {
            type: 'queued_command',
            prompt: 'still broken on mobile',
            source_uuid: 'q1',
            origin: { kind: 'human' },
          },
        }),
        line({
          type: 'assistant',
          sessionId: 'sess-1',
          timestamp: iso(53_000),
          message: { id: 'syn', model: '<synthetic>', usage: { input_tokens: 5 } },
        }),
      ].join(''),
    )

    const scanner = new UsageScanner({ sqlite, claudeProjectsDir: claude, codexSessionsDir: codex })
    await scanner.scan()
    const snap = queryUsageLedger(sqlite, { range: 'today', now: NOW })

    assert.equal(snap.totals.requests, 2)
    assert.equal(snap.totals.input, 20)
    assert.equal(snap.totals.cacheRead, 200_000)
    assert.equal(snap.totals.cacheWrite, 6_000)
    assert.equal(snap.totals.output, 400)
    assert.equal(snap.totals.rounds, 2, 'typed prompt + mid-turn queued prompt')

    // Opus 5.5: $4 in, $0.20 cache read, 1.25x/2x input for 5m/1h writes, $20 out.
    const perRequest = (10 * 4 + 100_000 * 0.2 + 1_000 * 5 + 2_000 * 8 + 200 * 20) / 1e6
    assert.ok(Math.abs(snap.totals.costUsd - 2 * perRequest) < 1e-9)
    assert.equal(snap.totals.unpricedTokens, 0)

    const [session] = snap.sessions
    assert.equal(session?.projectName, 'app')
    assert.equal(session?.title, 'fix the login bug')
    assert.deepEqual(session?.models, [{ model: 'claude-opus-5-5', rounds: 2 }])

    // Rescanning an unchanged file adds nothing.
    await scanner.scan()
    assert.equal(queryUsageLedger(sqlite, { range: 'today', now: NOW }).totals.requests, 2)
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('incremental scan consumes only complete lines', async () => {
  const { home, claude, codex, sqlite } = await fixture()
  try {
    const file = join(claude, 'C--work-app', 'sess-1.jsonl')
    await writeFile(file, claudeAssistant('msg_1', 'req_1', 30_000))
    const scanner = new UsageScanner({ sqlite, claudeProjectsDir: claude, codexSessionsDir: codex })
    await scanner.scan()

    // A line still being written must not be consumed or lost.
    const next = claudeAssistant('msg_2', 'req_2', 20_000)
    await appendFile(file, next.slice(0, 40))
    await scanner.scan()
    assert.equal(queryUsageLedger(sqlite, { range: 'today', now: NOW }).totals.requests, 1)

    await appendFile(file, next.slice(40))
    await scanner.scan()
    assert.equal(queryUsageLedger(sqlite, { range: 'today', now: NOW }).totals.requests, 2)
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('Codex rollouts: per-request usage, repeated totals skipped, injected context ignored', async () => {
  const { home, claude, codex, sqlite } = await fixture()
  try {
    const usage = (input: number, cached: number, output: number, total: number): unknown => ({
      type: 'event_msg',
      timestamp: iso(10_000),
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: total },
          last_token_usage: {
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
            reasoning_output_tokens: 5,
          },
        },
      },
    })
    const userMessage = (text: string, id: string): unknown => ({
      type: 'response_item',
      timestamp: iso(15_000),
      payload: { type: 'message', id, role: 'user', content: [{ type: 'input_text', text }] },
    })
    await writeFile(
      join(
        codex,
        '2026',
        '09',
        '30',
        'rollout-2026-09-30T10-00-00-01a0f2b7-c56c-7772-8949-3627c4a83198.jsonl',
      ),
      [
        { type: 'session_meta', timestamp: iso(20_000), payload: { id: 'cx-1', cwd: 'D:\\svc' } },
        {
          type: 'turn_context',
          timestamp: iso(19_000),
          payload: { model: 'gpt-5.6-sol', cwd: 'D:\\svc' },
        },
        userMessage('<environment_context>\n<cwd>D:\\svc</cwd>', 'm0'),
        userMessage('why is the build red', 'm1'),
        {
          type: 'event_msg',
          timestamp: iso(15_000),
          payload: { type: 'user_message', message: 'why is the build red' },
        },
        usage(20_000, 8_000, 100, 20_100),
        // Rate-limit refresh repeats the same cumulative total.
        usage(20_000, 8_000, 100, 20_100),
        usage(300_000, 0, 1_000, 321_100),
      ]
        .map(line)
        .join(''),
    )

    await new UsageScanner({ sqlite, claudeProjectsDir: claude, codexSessionsDir: codex }).scan()
    const snap = queryUsageLedger(sqlite, { range: 'today', now: NOW })

    assert.equal(snap.totals.requests, 2)
    assert.equal(snap.totals.input, 12_000 + 300_000)
    assert.equal(snap.totals.cacheRead, 8_000)
    assert.equal(snap.totals.output, 1_100)
    assert.equal(snap.totals.rounds, 1)
    assert.equal(snap.byProject[0]?.name, 'svc')

    // gpt-5.6-sol: short context $4 / $0.40 / $20; >272K input uses $8 / $0.80 / $30.
    const expected = (12_000 * 4 + 8_000 * 0.4 + 100 * 20) / 1e6 + (300_000 * 8 + 1_000 * 30) / 1e6
    assert.ok(Math.abs(snap.totals.costUsd - expected) < 1e-9)
    assert.deepEqual(snap.sessions[0]?.models, [{ model: 'gpt-5.6-sol', rounds: 1 }])
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('models without an official price report tokens but no cost', async () => {
  const { home, claude, codex, sqlite } = await fixture()
  try {
    await writeFile(
      join(claude, 'C--work-app', 'sess-1.jsonl'),
      claudeAssistant('msg_x', 'req_x', 5_000, 'claude-future-9'),
    )
    await new UsageScanner({ sqlite, claudeProjectsDir: claude, codexSessionsDir: codex }).scan()
    const snap = queryUsageLedger(sqlite, { range: 'today', now: NOW })
    assert.equal(snap.totals.costUsd, 0)
    assert.equal(snap.totals.unpricedTokens, snap.totals.tokens)
    assert.equal(snap.byModel[0]?.priced, false)
  } finally {
    sqlite.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('price lookup accepts CLI model id variants', () => {
  assert.equal(findModelPrice('claude-opus-5-5')?.input, 4)
  assert.equal(findModelPrice('claude-opus-4-6[1m]')?.input, 5)
  assert.equal(findModelPrice('claude-haiku-4-5-20251001')?.output, 5)
  assert.equal(findModelPrice('claude-fable-5-1')?.cacheRead, 0.25)
  assert.equal(findModelPrice('gpt-5.6-sol-wm')?.model, 'gpt-5.6-sol')
  assert.equal(findModelPrice('mimo-v2.6-pro'), undefined)
  const price = findModelPrice('gpt-6-astra')!
  const usage = { input: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }
  assert.equal(priceRequest(price, usage), 20, 'above 272K input uses long-context rate')
})

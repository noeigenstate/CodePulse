import assert from 'node:assert/strict'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  CLAUDE_USAGE_POLL_INTERVAL_MS,
  readRecentClaudeTokenSnapshots,
} from '../apps/desktop/src/main/claude-usage-poller.js'

test('Claude usage poller defaults to a responsive quota sync interval', () => {
  assert.equal(CLAUDE_USAGE_POLL_INTERVAL_MS, 5_000)
})

test('Claude usage poller reads recent transcript usage snapshots', async () => {
  const home = join(tmpdir(), `codepulse-claude-poller-${Date.now()}`)
  const projectDir = join(home, 'projects', 'E---project-alpha')
  const transcript = join(projectDir, 'session-alpha.jsonl')

  await mkdir(projectDir, { recursive: true })
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: 'user',
        cwd: 'E:\\project\\alpha',
        sessionId: 'session-alpha',
        timestamp: '2026-06-12T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\project\\alpha',
        sessionId: 'session-alpha',
        message: {
          model: 'claude-fable-5',
          usage: {
            input_tokens: 12000,
            cache_creation_input_tokens: 3000,
            cache_read_input_tokens: 500,
            output_tokens: 700,
          },
        },
        timestamp: '2026-06-12T10:01:00.000Z',
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const events = await readRecentClaudeTokenSnapshots(home)
    const event = events[0]

    assert.equal(events.length, 1)
    assert.equal(event?.source, 'claude_code')
    assert.equal(event?.eventType, 'token_snapshot')
    assert.equal(event?.workspacePath, 'E:\\project\\alpha')
    assert.equal(event?.externalSessionId, 'session-alpha')
    assert.equal(event?.model, 'claude-fable-5')
    assert.equal(event?.token?.input, 15500)
    assert.equal(event?.token?.cachedInput, 3500)
    assert.equal(event?.token?.output, 700)
    assert.equal(event?.token?.total, 16200)
    assert.equal(event?.token?.contextWindow, 200000)
    assert.equal(event?.token?.contextUsedPercent, 7.75)
    assert.equal(event?.token?.accuracy, 'estimated')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Claude usage poller reads multiple recent project snapshots', async () => {
  const home = join(tmpdir(), `codepulse-claude-poller-multi-${Date.now()}`)
  const firstDir = join(home, 'projects', 'E---project-first')
  const secondDir = join(home, 'projects', 'E---project-second')

  await mkdir(firstDir, { recursive: true })
  await mkdir(secondDir, { recursive: true })
  await writeClaudeTranscript(join(firstDir, 'session-first.jsonl'), {
    cwd: 'E:\\project\\first',
    sessionId: 'session-first',
    model: 'claude-fable-5',
    inputTokens: 10000,
    outputTokens: 200,
  })
  await writeClaudeTranscript(join(secondDir, 'session-second.jsonl'), {
    cwd: 'E:\\project\\second',
    sessionId: 'session-second',
    model: 'claude-opus-4-5',
    inputTokens: 22000,
    outputTokens: 500,
  })

  try {
    const events = await readRecentClaudeTokenSnapshots(home)
    const byWorkspace = new Map(events.map((event) => [event.workspacePath, event]))

    assert.equal(events.length, 2)
    assert.equal(byWorkspace.get('E:\\project\\first')?.externalSessionId, 'session-first')
    assert.equal(byWorkspace.get('E:\\project\\first')?.token?.contextUsedPercent, 5)
    assert.equal(byWorkspace.get('E:\\project\\second')?.externalSessionId, 'session-second')
    assert.equal(byWorkspace.get('E:\\project\\second')?.model, 'claude-opus-4-5')
    assert.equal(byWorkspace.get('E:\\project\\second')?.token?.total, 22500)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Claude usage poller sorts transcripts by mtime before capping history', async () => {
  const home = join(tmpdir(), `codepulse-claude-poller-cap-${Date.now()}`)
  const oldPayload = JSON.stringify({
    type: 'assistant',
    cwd: 'E:\\project\\old',
    sessionId: 'old-session',
    message: {
      model: 'claude-old',
      usage: { input_tokens: 1000, output_tokens: 100 },
    },
  })

  await Promise.all(
    Array.from({ length: 310 }, async (_, i) => {
      const dir = join(home, 'projects', `z-old-${String(i).padStart(3, '0')}`)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, `old-${i}.jsonl`), oldPayload, 'utf8')
    }),
  )

  const freshDir = join(home, 'projects', 'a-fresh')
  await mkdir(freshDir, { recursive: true })
  await writeClaudeTranscript(join(freshDir, 'fresh-session.jsonl'), {
    cwd: 'E:\\project\\fresh',
    sessionId: 'fresh-session',
    model: 'claude-fable-5',
    inputTokens: 42000,
    outputTokens: 300,
  })

  try {
    const events = await readRecentClaudeTokenSnapshots(home, 1)

    assert.equal(events.length, 1)
    assert.equal(events[0]?.workspacePath, 'E:\\project\\fresh')
    assert.equal(events[0]?.externalSessionId, 'fresh-session')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('Claude usage poller ignores sidechain transcript usage when user-visible usage exists', async () => {
  const home = join(tmpdir(), `codepulse-claude-poller-sidechain-${Date.now()}`)
  const projectDir = join(home, 'projects', 'E---project-sidechain')
  const transcript = join(projectDir, 'session-sidechain.jsonl')

  await mkdir(projectDir, { recursive: true })
  await writeFile(
    transcript,
    [
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\project\\sidechain',
        sessionId: 'session-sidechain',
        message: {
          model: 'claude-fable-5',
          usage: { input_tokens: 9000, output_tokens: 100 },
        },
      }),
      JSON.stringify({
        type: 'assistant',
        cwd: 'E:\\project\\sidechain',
        sessionId: 'session-sidechain',
        isSidechain: true,
        message: {
          model: 'claude-fable-5',
          usage: { input_tokens: 99000, output_tokens: 100 },
        },
      }),
    ].join('\n'),
    'utf8',
  )

  try {
    const events = await readRecentClaudeTokenSnapshots(home)

    assert.equal(events.length, 1)
    assert.equal(events[0]?.token?.input, 9000)
    assert.equal(events[0]?.token?.contextUsedPercent, 4.5)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function writeClaudeTranscript(
  path: string,
  options: {
    cwd: string
    sessionId: string
    model: string
    inputTokens: number
    outputTokens: number
  },
): Promise<void> {
  await writeFile(
    path,
    JSON.stringify({
      type: 'assistant',
      cwd: options.cwd,
      sessionId: options.sessionId,
      message: {
        model: options.model,
        usage: {
          input_tokens: options.inputTokens,
          output_tokens: options.outputTokens,
        },
      },
    }),
    'utf8',
  )
}

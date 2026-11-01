import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { normalizeEvent, StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { fromCodexHook } from '@codepulse/adapters'
import { normalizeDeviceDisplay, isCodexAuxiliarySession } from '@codepulse/shared'
import { registerEventRoutes } from '../packages/local-server/src/routes/events.js'
import { CodexSessionTitles } from '../packages/local-server/src/codex-session-titles.js'
import { SessionSyncService } from '../packages/local-server/src/session-sync.js'
import { startDeviceServer, DEVICE_AUTH_HEADER, DEVICE_STATUS_PATH } from '@codepulse/local-server'

const envelope =
  'This is an app-generated request for a suggested next user message. The user did not write this message.'
const config = normalizeDeviceDisplay({})
function hook(sessionId: string, hookEvent = 'UserPromptSubmit', extra = {}) {
  return {
    source: 'codex',
    session_id: sessionId,
    cwd: 'F:/private/CodePulse',
    hook_event_name: hookEvent,
    ...extra,
  }
}
function ingest(hub: StatusHub, raw: object) {
  return hub.ingest(normalizeEvent(fromCodexHook(raw)!))
}

test('exact auxiliary envelope removes early row and suppresses later tools/completions, not sibling tasks', () => {
  const hub = new StatusHub()
  ingest(
    hub,
    hook('real-one', 'UserPromptSubmit', { thread_name: '真实任务一', prompt: '帮我写下一步建议' }),
  )
  ingest(
    hub,
    hook('real-two', 'UserPromptSubmit', {
      thread_name: '真实任务二',
      prompt: `请分析：${envelope}`,
    }),
  )
  ingest(hub, hook('helper', 'SessionStart'))
  assert.equal(hub.snapshot().agents.length, 3)
  let events = 0,
    notifications = 0
  hub.on('event', () => events++)
  hub.on('notification', () => notifications++)
  assert.equal(
    ingest(hub, hook('helper', 'UserPromptSubmit', { prompt: envelope + '\n\nSuggest...' })),
    false,
  )
  for (const type of ['PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd', 'SessionStart']) {
    assert.equal(ingest(hub, hook('helper', type)), false)
  }
  assert.equal(events, 0)
  assert.equal(notifications, 0)
  assert.equal(hub.snapshot().agents.length, 2)
  const device = toDeviceStatusV1(hub.snapshot(), config)
  assert.equal(device.threadTotal, 2)
  assert.deepEqual(
    new Set(device.threads!.map((row) => row.title)),
    new Set(['真实任务一', '真实任务二']),
  )
  assert.equal(new Set(device.threads!.map((row) => row.id)).size, 2)
  // Provider namespace and quota-only account state are independent of filtering.
  assert.equal(
    hub.ingest({
      id: 'claude',
      source: 'claude_code',
      eventType: 'prompt_submit',
      externalSessionId: 'helper',
      timestamp: Date.now(),
    }),
    true,
  )
  assert.equal(
    hub.observeQuota({
      id: 'quota',
      source: 'codex',
      eventType: 'token_snapshot',
      timestamp: Date.now(),
      internal: { quotaRefresh: true },
      token: { accuracy: 'exact', rateLimits: { sevenDay: { usedPercent: 4 } } },
    }),
    true,
  )
  assert.equal(
    hub.observeQuota({
      id: 'helper-quota',
      source: 'codex',
      eventType: 'token_snapshot',
      externalSessionId: 'helper',
      timestamp: Date.now(),
    }),
    false,
  )
})

test('known guardian metadata is excluded; user forks, unknown sources, and ordinary review names survive', () => {
  assert.equal(isCodexAuxiliarySession({ thread_source: 'guardian_review' }), true)
  assert.equal(isCodexAuxiliarySession({ source: { subagent: { other: 'guardian' } } }), true)
  for (const raw of [
    { thread_source: 'user', parent_thread_id: 'parent' },
    { thread_source: 'future_source', title: 'Guardian review' },
    { thread_source: 'user', source: { subagent: { other: 'guardian' } } },
  ])
    assert.equal(isCodexAuxiliarySession(raw, envelope), raw.thread_source !== 'user')
  const hub = new StatusHub()
  assert.equal(
    ingest(
      hub,
      hook('user-fork', 'UserPromptSubmit', {
        thread_source: 'user',
        prompt: envelope,
        thread_name: 'Guardian review',
      }),
    ),
    true,
  )
  assert.equal(
    ingest(
      hub,
      hook('unknown', 'UserPromptSubmit', {
        thread_source: 'future_source',
        thread_name: 'Review',
        prompt: '普通任务',
      }),
    ),
    true,
  )
  assert.equal(
    ingest(hub, hook('guardian', 'SessionStart', { thread_source: 'guardian_review' })),
    false,
  )
  assert.equal(hub.snapshot().agents.length, 2)
  // Without a session ID the marker drops only this event, never the workspace.
  assert.equal(
    ingest(hub, { ...hook('', 'UserPromptSubmit', { prompt: envelope }), session_id: undefined }),
    false,
  )
  assert.equal(hub.snapshot().agents.length, 2)
})

test('task title survives tools, wins over workspace and stays UTF-8 bounded without using prompts', () => {
  const hub = new StatusHub()
  ingest(
    hub,
    hook('named', 'UserPromptSubmit', {
      thread_name: '  修复\n同步\t标题  ',
      prompt: 'private prompt',
    }),
  )
  ingest(hub, hook('named', 'PreToolUse', { tool_name: 'ReadFile' }))
  const before = hub.snapshot()
  assert.equal(toDeviceStatusV1(before, config).threads![0]!.title, '修复 同步 标题')
  const expected = structuredClone(before.agents)
  let notifications = 0,
    events = 0
  hub.on('event', () => events++)
  hub.on('notification', () => notifications++)
  hub.updateSessionTitles(
    'codex',
    new Map([
      ['named', '同步标题😀'.repeat(30)],
      ['absent', '不应生成任务'],
    ]),
  )
  const after = hub.snapshot()
  assert.equal(after.agents.length, 1)
  expected[0]!.taskTitle = after.agents[0]!.taskTitle
  assert.deepEqual(after.agents, expected)
  assert.equal(events + notifications, 0)
  const d = toDeviceStatusV1(after, config)
  assert.ok(Buffer.byteLength(d.threads![0]!.title) <= 96)
  assert.ok(!d.threads![0]!.title.includes('\ufffd'))
  assert.equal(d.threads![0]!.id, toDeviceStatusV1(before, config).threads![0]!.id)
  assert.ok(!JSON.stringify(d).includes('private prompt'))
  ingest(hub, hook('untitled', 'UserPromptSubmit', { thread_name: '  ', prompt: 'not a title' }))
  assert.ok(toDeviceStatusV1(hub.snapshot(), config).threads!.some((t) => t.title === 'CodePulse'))
})

test('native index handles rename, malformed rows, missing index and concurrent reads', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-title-index-'))
  try {
    const index = new CodexSessionTitles(home)
    assert.equal((await index.read()).size, 0)
    const path = join(home, 'session_index.jsonl')
    await writeFile(path, JSON.stringify({ id: 'a', thread_name: '任务一' }) + '\ninvalid\nnull\n')
    const [a, b] = await Promise.all([index.read(), index.read()])
    assert.equal(a.get('a'), '任务一')
    assert.deepEqual(a, b)
    await appendFile(path, JSON.stringify({ id: 'a', thread_name: '改名后任务' }) + '\n{"id":')
    assert.equal((await index.read()).get('a'), '改名后任务')
    await rm(path)
    assert.equal((await index.read()).get('a'), '改名后任务')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('HTTP ingestion, native names and device endpoint share the preview projection', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-title-route-'))
  const hub = new StatusHub(),
    app = Fastify()
  let device: Awaited<ReturnType<typeof startDeviceServer>> | undefined
  try {
    await writeFile(
      join(home, 'session_index.jsonl'),
      JSON.stringify({ id: 'user', thread_name: '真正开启的任务' }) + '\n',
    )
    registerEventRoutes(app, hub, { codexHome: home })
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      payload: [
        hook('user'),
        hook('suggestion', 'UserPromptSubmit', { prompt: envelope }),
        hook('suggestion', 'Stop'),
      ],
    })
    assert.equal(response.statusCode, 202)
    assert.equal(hub.snapshot().agents.length, 1)
    assert.equal(hub.snapshot().agents[0]!.taskTitle, '真正开启的任务')
    device = await startDeviceServer({
      hub,
      getDisplayConfig: () => config,
      host: '127.0.0.1',
      port: 0,
      authToken: 'd'.repeat(32),
      serverId: 'title-test',
      publishMdns: false,
    })
    const response2 = await fetch(device.url + DEVICE_STATUS_PATH, {
      headers: { [DEVICE_AUTH_HEADER]: 'd'.repeat(32) },
    })
    const payload = await response2.json()
    const preview = toDeviceStatusV1(hub.snapshot(), config)
    assert.deepEqual(payload.threads, preview.threads)
    assert.equal(payload.revision, preview.revision)
    assert.equal(payload.threadTotal, 1)
    assert.equal(payload.threads[0].title, '真正开启的任务')
  } finally {
    await device?.close()
    await app.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('disk scan filters guardian by child identity, keeps parallel users/fork and follows native rename', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codepulse-title-sync-'))
  const hub = new StatusHub()
  const sync = new SessionSyncService({
    hub,
    userHome: home,
    codexHome: home,
    disableWatch: true,
    codexProcessAlive: () => true,
  })
  try {
    const dir = join(home, 'sessions', '2026', '10', '23')
    await mkdir(dir, { recursive: true })
    const rootId = '10000000-0000-4000-8000-000000000001'
    const forkId = '10000000-0000-4000-8000-000000000002'
    const guardianId = '10000000-0000-4000-8000-000000000003'
    const suggestionId = '10000000-0000-4000-8000-000000000004'
    for (const [id, meta, extra] of [
      [rootId, { thread_source: 'user' }, []],
      [forkId, { thread_source: 'user', session_id: rootId, forked_from_id: rootId }, []],
      [
        guardianId,
        { thread_source: 'guardian_review', session_id: rootId, parent_thread_id: rootId },
        [],
      ],
      [
        suggestionId,
        {},
        [{ type: 'event_msg', payload: { type: 'user_message', message: envelope } }],
      ],
    ] as const) {
      await writeFile(
        join(dir, `rollout-${id}.jsonl`),
        [{ type: 'session_meta', payload: { id, cwd: 'F:/work/same-project', ...meta } }, ...extra]
          .map((row) => JSON.stringify(row))
          .join('\n'),
      )
    }
    const index = join(home, 'session_index.jsonl')
    await writeFile(
      index,
      [
        { id: rootId, thread_name: '主任务' },
        { id: forkId, thread_name: '用户分支任务' },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    )
    await sync.syncNow(['codex'])
    assert.deepEqual(
      new Set(
        hub
          .snapshot()
          .agents.filter((a) => a.externalSessionId)
          .map((a) => a.externalSessionId),
      ),
      new Set([rootId, forkId]),
    )
    assert.deepEqual(
      new Set(
        hub
          .snapshot()
          .agents.filter((a) => a.taskTitle)
          .map((a) => a.taskTitle),
      ),
      new Set(['主任务', '用户分支任务']),
    )
    assert.equal(ingest(hub, hook(guardianId, 'Stop')), false)
    ingest(hub, hook(rootId, 'UserPromptSubmit'))
    const old = hub.snapshot().agents.find((a) => a.externalSessionId === rootId)!
    await appendFile(index, JSON.stringify({ id: rootId, thread_name: '更清晰的任务名' }) + '\n')
    await sync.syncNow(['codex'])
    const renamed = hub.snapshot().agents.find((a) => a.externalSessionId === rootId)!
    assert.equal(renamed.taskTitle, '更清晰的任务名')
    assert.equal(renamed.lastEventAt, old.lastEventAt)
    assert.equal(renamed.state, old.state)
  } finally {
    sync.stop()
    await rm(home, { recursive: true, force: true })
  }
})

test('project suggestions and ambient review hooks never become task cards, regardless of their cwd', () => {
  const prompts = [
    '# Overview\n\nGenerate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project:',
    'You are an expert at upholding safety and compliance standards for Codex ambient suggestions.',
  ]
  for (const [index, prompt] of prompts.entries()) {
    const hub = new StatusHub()
    ingest(hub, hook('user', 'UserPromptSubmit', { thread_name: '真实用户任务' }))
    const cwd = index ? 'C:/Users/user/AppData/Local/OpenAI/Codex/bin/0123456789abcdef' : 'F:/private/CodePulse'
    assert.equal(ingest(hub, hook('helper', 'UserPromptSubmit', { cwd, prompt: prompt.replace(/\n/g, '\r\n') + '\nRest of the internal request.' })), false)
    assert.equal(ingest(hub, hook('helper', 'Stop', { cwd })), false)
    assert.equal(toDeviceStatusV1(hub.snapshot(), config).threadTotal, 1)
    // A human task quoting/discussing the marker, or explicitly sourced as user, survives.
    assert.equal(ingest(hub, hook('quoted', 'UserPromptSubmit', { prompt: '请检查这段文本：' + prompt })), true)
    assert.equal(ingest(hub, hook('explicit-user', 'UserPromptSubmit', { thread_source: 'user', prompt })), true)
    assert.equal(hub.snapshot().agents.length, 3)
  }
})

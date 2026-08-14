import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { afterEach, test } from 'node:test'
import WebSocket from 'ws'
import { StatusHub } from '@codepulse/core'
import {
  startLocalServer,
  type CodexAppServerQuotaServiceOptions,
  type CodexAppServerQuotaSnapshot,
  type CodexQuotaServiceFactory,
  type LocalServer,
} from '@codepulse/local-server'
import type {
  Agent,
  DeviceStatus,
  NotificationRequest,
  ServerPushMessage,
  StatusSnapshot,
} from '@codepulse/shared'

const HOST = '127.0.0.1'
const openServers: LocalServer[] = []

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()))
})

test('GET /api/health returns liveness metadata', async () => {
  const { base } = await createApi()
  const { response, body } = await getJson<{ ok: boolean; ts: number }>(base, '/api/health')

  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(typeof body.ts, 'number')
})

test('GET /api/status and /api/device/status return idle snapshots before events', async () => {
  const { base } = await createApi()

  const status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  assert.equal(status.overall, 'idle')
  assert.deepEqual(status.agents, [])
  assert.equal(typeof status.updatedAt, 'number')

  const device = await getJsonBody<DeviceStatus>(base, '/api/device/status')
  assert.equal(device.mainState, 'idle')
  assert.equal(device.activeAgent, null)
  assert.equal(device.claudeContext, null)
  assert.equal(device.codexState, null)
  assert.equal(typeof device.updatedAt, 'number')
})

test('POST /api/events accepts single and batch hook payloads and updates status APIs', async () => {
  const { base } = await createApi()

  const prompt = await postJson<{ accepted: number; ignored: number }>(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-api',
    turn_id: 'codex-turn',
    cwd: 'E:/work/codepulse',
    prompt: 'add backend tests',
  })
  assert.equal(prompt.response.status, 202)
  assert.deepEqual(prompt.body, { accepted: 1, ignored: 0 })

  const toolPayload = {
    source: 'codex',
    hook_event_name: 'PreToolUse',
    session_id: 'codex-api',
    turn_id: 'codex-turn',
    tool_name: 'shell',
    command: 'pnpm test',
    _codepulse_event_id: 'hook:backend-retry',
    _codepulse_timestamp: 1_784_513_490_123,
  }
  const tool = await postJson<{ accepted: number; ignored: number }>(
    base,
    '/api/events',
    toolPayload,
  )
  assert.equal(tool.response.status, 202)
  const retriedTool = await postJson<{ accepted: number; ignored: number }>(
    base,
    '/api/events',
    toolPayload,
  )
  assert.equal(retriedTool.response.status, 202)

  let status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  let codex = status.agents.find((agent) => agent.agentType === 'codex')
  assert.equal(status.overall, 'running')
  assert.equal(codex?.state, 'TOOL_RUNNING')
  assert.equal(codex?.toolName, 'shell')
  assert.equal(codex?.toolCallCount, 1)
  assert.equal(codex?.workspacePath, 'E:/work/codepulse')

  const mixed = await postJson<{ accepted: number; ignored: number }>(base, '/api/events', [
    {
      source: 'claude_code',
      hook_event_name: 'Notification',
      session_id: 'claude-api',
      message: 'Claude needs your permission before running a command',
    },
    { source: 'unknown_agent', hook_event_name: 'Nope' },
  ])
  assert.equal(mixed.response.status, 202)
  assert.deepEqual(mixed.body, { accepted: 1, ignored: 1 })

  status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  const claude = status.agents.find((agent) => agent.agentType === 'claude_code')
  assert.equal(status.overall, 'attention')
  assert.equal(claude?.state, 'WAITING_PERMISSION')

  const device = await getJsonBody<DeviceStatus>(base, '/api/device/status')
  assert.equal(device.mainState, 'waiting_permission')
  assert.equal(device.activeAgent, 'claude_code')

  codex = status.agents.find((agent) => agent.agentType === 'codex')
  assert.equal(codex?.state, 'TOOL_RUNNING')
})

test('Codex App Server quota stays authoritative across hooks and account switches', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  let callbacks!: CodexAppServerQuotaServiceOptions
  let refreshCount = 0
  let stopCount = 0
  const factory: CodexQuotaServiceFactory = (options) => {
    callbacks = options
    return {
      start: async () => {
        options.onAccountScope?.('scope-a')
        options.onSnapshot(codexQuotaSnapshot('scope-a', 60, 1))
      },
      refresh: async () => {
        refreshCount += 1
        return undefined
      },
      stop: () => {
        stopCount += 1
      },
    }
  }
  const server = await startLocalServer({
    hub,
    host: HOST,
    port: await freePort(),
    disableSessionSync: true,
    codexQuotaServiceFactory: factory,
    authToken: false,
  })

  try {
    const prompt = await postJson(server.url, '/api/events', {
      source: 'codex',
      hook_event_name: 'UserPromptSubmit',
      session_id: 'authoritative-codex',
      cwd: 'E:/project/authoritative',
      context_used_percent: 20,
      context_window_size: 258_400,
      rate_limits: {
        primary: {
          used_percentage: 95,
          resets_at: 1_900_000_000,
          window_minutes: 10_080,
        },
      },
    })
    assert.equal(prompt.response.status, 202)
    await new Promise((resolve) => setImmediate(resolve))

    let agents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
    let project = agents.find((agent) => agent.workspacePath === 'E:/project/authoritative')
    let accountQuota = agents.find((agent) => !agent.workspacePath)
    assert.equal(project?.token?.contextUsedPercent, 20)
    assert.equal(project?.token?.rateLimits, undefined)
    assert.equal(accountQuota?.token?.rateLimits?.sevenDay?.usedPercent, 60)
    assert.equal(refreshCount, 0)

    for (let index = 1; index <= 4; index += 1) {
      callbacks.onSnapshot(codexQuotaSnapshot('scope-a', 10, 10 + index, 'notification'))
    }
    accountQuota = hub
      .snapshot()
      .agents.find((agent) => agent.agentType === 'codex' && !agent.workspacePath)
    assert.equal(accountQuota?.token?.rateLimits?.sevenDay?.usedPercent, 60)

    for (let index = 1; index <= 4; index += 1) {
      callbacks.onSnapshot(codexQuotaSnapshot('scope-a', 10, 20 + index))
    }
    accountQuota = hub
      .snapshot()
      .agents.find((agent) => agent.agentType === 'codex' && !agent.workspacePath)
    assert.equal(accountQuota?.token?.rateLimits?.sevenDay?.usedPercent, 60)
    callbacks.onSnapshot(codexQuotaSnapshot('scope-a', 10, 25))
    accountQuota = hub
      .snapshot()
      .agents.find((agent) => agent.agentType === 'codex' && !agent.workspacePath)
    assert.equal(accountQuota?.token?.rateLimits?.sevenDay?.usedPercent, 10)

    await postJson(server.url, '/api/events', {
      source: 'codex',
      hook_event_name: 'PreToolUse',
      session_id: 'authoritative-codex',
      cwd: 'E:/project/authoritative',
      tool_name: 'shell',
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(refreshCount, 0)

    const terminalHook = {
      source: 'codex',
      hook_event_name: 'Stop',
      session_id: 'authoritative-codex',
      cwd: 'E:/project/authoritative',
      _codepulse_event_id: 'hook:authoritative-stop',
      _codepulse_timestamp: Date.now(),
    }
    await postJson(server.url, '/api/events', terminalHook)
    await postJson(server.url, '/api/events', terminalHook)
    await postJson(server.url, '/api/events', {
      source: 'codex',
      hook_event_name: 'SessionEnd',
      session_id: 'authoritative-codex',
      cwd: 'E:/project/authoritative',
      _codepulse_event_id: 'hook:authoritative-session-end',
      _codepulse_timestamp: Date.now(),
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(refreshCount, 1)

    await postJson(server.url, '/api/events', {
      source: 'codex',
      hook_event_name: 'SessionEnd',
      session_id: 'authoritative-codex',
      turn_id: 'different-terminal-turn',
      cwd: 'E:/project/authoritative',
      _codepulse_event_id: 'hook:different-session-end',
      _codepulse_timestamp: Date.now(),
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(refreshCount, 2)

    const statusFrames: StatusSnapshot[] = []
    hub.on('status', (status) => statusFrames.push(status))
    callbacks.onAccountScope?.('scope-b')
    callbacks.onSnapshot(codexQuotaSnapshot('scope-b', 3, 2))

    assert.equal(statusFrames.length, 2)
    assert.equal(
      statusFrames[0]?.agents.some(
        (agent) => agent.agentType === 'codex' && Boolean(agent.token?.rateLimits),
      ),
      false,
      'an account boundary must clear the previous account before the new read arrives',
    )
    accountQuota = statusFrames[1]?.agents.find(
      (agent) => agent.agentType === 'codex' && !agent.workspacePath,
    )
    assert.equal(accountQuota?.token?.rateLimits?.sevenDay?.usedPercent, 3)

    await server.syncSessions()
    assert.equal(refreshCount, 3)

    agents = hub.snapshot().agents.filter((agent) => agent.agentType === 'codex')
    project = agents.find((agent) => agent.workspacePath === 'E:/project/authoritative')
    assert.equal(project?.token?.rateLimits, undefined)
  } finally {
    await server.close()
  }
  assert.equal(stopCount, 1)
})

test('Codex account boundary clears stale quota when official reads are unavailable', async () => {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  hub.ingest({
    id: 'stale-rollout-quota',
    source: 'codex',
    eventType: 'token_snapshot',
    externalSessionId: 'unavailable-quota',
    cwd: 'E:/project/unavailable-quota',
    timestamp: 1,
    token: {
      rateLimitId: 'codex',
      rateLimits: {
        sevenDay: { usedPercent: 88, resetsAt: 1_900_000_000, windowMinutes: 10_080 },
      },
      accuracy: 'estimated',
    },
  })

  const factory: CodexQuotaServiceFactory = (options) => ({
    start: async () => {
      options.onAccountScope?.('scope-without-quota')
    },
    refresh: async () => undefined,
    stop: () => undefined,
  })
  const server = await startLocalServer({
    hub,
    host: HOST,
    port: await freePort(),
    disableSessionSync: true,
    codexQuotaServiceFactory: factory,
    authToken: false,
  })

  try {
    await new Promise((resolve) => setTimeout(resolve, 5))
    let codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.token?.rateLimits, undefined)

    await postJson(server.url, '/api/events', {
      source: 'codex',
      hook_event_name: 'UserPromptSubmit',
      session_id: 'unavailable-quota',
      cwd: 'E:/project/unavailable-quota',
      context_used_percent: 24,
      context_window_size: 258_400,
      rate_limits: {
        primary: {
          used_percentage: 99,
          resets_at: 1_900_000_000,
          window_minutes: 10_080,
        },
      },
    })
    codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
    assert.equal(codex?.token?.contextUsedPercent, 24)
    assert.equal(codex?.token?.rateLimits, undefined)
  } finally {
    await server.close()
  }
})

test('POST /api/events rejects completely unrecognized payloads', async () => {
  const { base } = await createApi()
  const bad = await postJson<{ accepted: number; ignored: number }>(base, '/api/events', {
    foo: 'bar',
  })

  assert.equal(bad.response.status, 400)
  assert.deepEqual(bad.body, { accepted: 0, ignored: 1 })
})

test('POST /api/events rejects oversized batches', async () => {
  const { base } = await createApi()
  const oversized = Array.from({ length: 1001 }, (_, index) => ({
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: `batch-${index}`,
  }))

  const response = await postJson<{ error: string; max: number }>(base, '/api/events', oversized)

  assert.equal(response.response.status, 413)
  assert.deepEqual(response.body, { error: 'too_many_events', max: 1000 })
})

test('POST /api/ack/:agent clears unread terminal results', async () => {
  const { base } = await createApi()

  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'ack-api',
    turn_id: 'ack-turn',
  })
  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'Stop',
    session_id: 'ack-api',
    turn_id: 'ack-turn',
    last_message: 'done',
  })

  let status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  assert.equal(status.agents.find((agent) => agent.agentType === 'codex')?.unread, true)

  const ack = await postJson<{ ok: boolean }>(base, '/api/ack/codex')
  assert.equal(ack.response.status, 200)
  assert.deepEqual(ack.body, { ok: true })

  status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  assert.equal(status.agents.find((agent) => agent.agentType === 'codex')?.unread, false)
})

test('POST /api/ack/:agent can clear only one workspace', async () => {
  const { base } = await createApi()

  for (const project of ['a', 'b']) {
    await postJson(base, '/api/events', {
      source: 'codex',
      hook_event_name: 'UserPromptSubmit',
      session_id: `ack-${project}`,
      cwd: `E:/project/${project}`,
    })
    await postJson(base, '/api/events', {
      source: 'codex',
      hook_event_name: 'Stop',
      session_id: `ack-${project}`,
      cwd: `E:/project/${project}`,
      last_message: 'done',
    })
  }

  const ack = await postJson<{ ok: boolean }>(base, '/api/ack/codex', {
    workspacePath: 'E:/project/a',
  })
  assert.equal(ack.response.status, 200)
  assert.deepEqual(ack.body, { ok: true })

  const status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  const byWorkspace = new Map(status.agents.map((agent) => [agent.workspacePath, agent.unread]))
  assert.equal(byWorkspace.get('E:/project/a'), false)
  assert.equal(byWorkspace.get('E:/project/b'), true)
})

test('POST /api/ack/:agent rejects unknown agent names', async () => {
  const { base } = await createApi()

  const response = await postJson<{ error: string }>(base, '/api/ack/not-an-agent')

  assert.equal(response.response.status, 400)
  assert.deepEqual(response.body, { error: 'invalid_agent' })
})

test('POST /api/mute toggles notification sound behavior', async () => {
  const notifications: NotificationRequest[] = []
  const { base, hub } = await createApi()
  hub.on('notification', (note) => notifications.push(note))

  const muted = await postJson<{ ok: boolean; muted: boolean }>(base, '/api/mute', {
    muted: true,
  })
  assert.equal(muted.response.status, 200)
  assert.deepEqual(muted.body, { ok: true, muted: true })

  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'mute-api',
    turn_id: 'mute-turn',
  })
  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'Stop',
    session_id: 'mute-api',
    turn_id: 'mute-turn',
    last_message: 'done',
  })
  assert.equal(notifications.at(-1)?.level, 'normal')
  assert.equal(notifications.at(-1)?.sound, false)

  const unmuted = await postJson<{ ok: boolean; muted: boolean }>(base, '/api/mute', {
    muted: false,
  })
  assert.deepEqual(unmuted.body, { ok: true, muted: false })

  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'UserPromptSubmit',
    session_id: 'unmute-api',
    turn_id: 'unmute-turn',
  })
  await postJson(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'Stop',
    session_id: 'unmute-api',
    turn_id: 'unmute-turn',
    last_message: 'done',
  })
  assert.equal(notifications.at(-1)?.level, 'normal')
  assert.equal(notifications.at(-1)?.sound, true)
})

test('GET /api/agents/detect returns supported agent detection records', async () => {
  const { base } = await createApi()
  const body = await getJsonBody<{ agents: Agent[] }>(base, '/api/agents/detect')

  assert.equal(Array.isArray(body.agents), true)
  assert.equal(body.agents.length, 4)
  assert.deepEqual(body.agents.map((agent) => agent.type).sort(), [
    'claude_code',
    'codex',
    'grok',
    'kimi',
  ])
  for (const agent of body.agents) {
    assert.equal(typeof agent.installed, 'boolean')
    assert.equal(typeof agent.configured, 'boolean')
    assert.equal(typeof agent.name, 'string')
  }
})

test('GET /ws sends the initial snapshot and pushes later status changes', async () => {
  const { base } = await createApi()
  const socket = await connectWebSocket(base.replace('http://', 'ws://') + '/ws')
  try {
    const initial = await socket.next()
    assert.equal(initial.type, 'status')
    assert.equal(initial.payload.overall, 'idle')

    await postJson(base, '/api/events', {
      source: 'codex',
      hook_event_name: 'UserPromptSubmit',
      session_id: 'ws-api',
      turn_id: 'ws-turn',
      prompt: 'exercise websocket',
    })

    const pushed = await socket.next()
    assert.equal(pushed.type, 'status')
    assert.equal(pushed.payload.overall, 'running')
    assert.equal(pushed.payload.agents[0]?.agentType, 'codex')
  } finally {
    socket.close()
  }
})

test('status updates skip serialization when no WebSocket client is connected', async () => {
  const { hub } = await createApi()

  assert.doesNotThrow(() => {
    hub.ingest({
      id: 'ws-no-client-serialization',
      source: 'codex',
      eventType: 'token_snapshot',
      // BigInt is an intentional serialization sentinel. It must remain harmless
      // while the WebSocket client set is empty because no payload will be sent.
      token: { input: 1n as unknown as number, accuracy: 'unknown' },
      timestamp: Date.now(),
    })
  })
})

async function createApi(): Promise<{ base: string; hub: StatusHub }> {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  const server = await startLocalServer({
    hub,
    host: HOST,
    port: await freePort(),
    disableSessionSync: true,
    disableCodexAppServer: true,
    authToken: false,
  })
  openServers.push(server)
  return { base: server.url, hub }
}

async function getJsonBody<T>(base: string, path: string): Promise<T> {
  return (await getJson<T>(base, path)).body
}

async function getJson<T>(base: string, path: string): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${base}${path}`)
  return { response, body: (await response.json()) as T }
}

async function postJson<T = unknown>(
  base: string,
  path: string,
  body?: unknown,
): Promise<{ response: Response; body: T }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { response, body: (await response.json()) as T }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, HOST, () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Expected an ephemeral TCP port'))
        return
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}

/**
 * Builds an official Codex weekly-quota snapshot for server integration tests.
 *
 * @param accountScope Process-local account discriminator.
 * @param usedPercent Weekly percentage returned by App Server.
 * @param updatedAt Deterministic observation time.
 * @param source Protocol path that produced the quota observation.
 * @returns Sanitized App Server quota snapshot.
 */
function codexQuotaSnapshot(
  accountScope: string,
  usedPercent: number,
  updatedAt: number,
  source: CodexAppServerQuotaSnapshot['source'] = 'read',
): CodexAppServerQuotaSnapshot {
  return {
    accountScope,
    updatedAt,
    source,
    token: {
      rateLimitId: 'codex',
      rateLimitName: 'Codex',
      rateLimits: {
        sevenDay: { usedPercent, resetsAt: 1_900_000_000, windowMinutes: 10_080 },
      },
      accuracy: 'exact',
    },
  }
}

interface TestWebSocket {
  close: () => void
  addEventListener: (
    event: 'open' | 'error' | 'message' | 'close',
    listener: (event: { data?: unknown; error?: unknown }) => void,
    options?: { once?: boolean },
  ) => void
}

interface BufferedWebSocket {
  close: () => void
  next: () => Promise<ServerPushMessage>
}

async function connectWebSocket(url: string): Promise<BufferedWebSocket> {
  const socket = new WebSocket(url) as unknown as TestWebSocket
  const messages: ServerPushMessage[] = []
  const waiters: Array<(message: ServerPushMessage) => void> = []

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as ServerPushMessage
    const waiter = waiters.shift()
    if (waiter) waiter(message)
    else messages.push(message)
  })

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true })
      socket.addEventListener(
        'error',
        (event) => reject(event.error ?? new Error('WebSocket error')),
        {
          once: true,
        },
      )
    }),
    'Timed out connecting to /ws',
  )

  return {
    close: () => socket.close(),
    next: async () => {
      const cached = messages.shift()
      if (cached) return cached
      return await withTimeout(
        new Promise<ServerPushMessage>((resolve) => waiters.push(resolve)),
        'Timed out waiting for /ws message',
      )
    },
  }
}

async function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 3000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

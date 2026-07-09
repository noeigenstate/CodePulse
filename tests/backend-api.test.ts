import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { afterEach, test } from 'node:test'
import { StatusHub } from '@codepulse/core'
import { startLocalServer, type LocalServer } from '@codepulse/local-server'
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

  const tool = await postJson<{ accepted: number; ignored: number }>(base, '/api/events', {
    source: 'codex',
    hook_event_name: 'PreToolUse',
    session_id: 'codex-api',
    turn_id: 'codex-turn',
    tool_name: 'shell',
    command: 'pnpm test',
  })
  assert.equal(tool.response.status, 202)

  let status = await getJsonBody<StatusSnapshot>(base, '/api/status')
  let codex = status.agents.find((agent) => agent.agentType === 'codex')
  assert.equal(status.overall, 'running')
  assert.equal(codex?.state, 'TOOL_RUNNING')
  assert.equal(codex?.toolName, 'shell')
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
  assert.equal(body.agents.length, 3)
  assert.deepEqual(body.agents.map((agent) => agent.type).sort(), [
    'claude_code',
    'codex',
    'grok',
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

async function createApi(): Promise<{ base: string; hub: StatusHub }> {
  const hub = new StatusHub({ sessionThrottleMs: 0, permissionThrottleMs: 0 })
  const server = await startLocalServer({ hub, host: HOST, port: await freePort() })
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

function nativeWebSocket(): new (url: string) => TestWebSocket {
  const websocket = (
    globalThis as typeof globalThis & { WebSocket?: new (url: string) => TestWebSocket }
  ).WebSocket
  if (!websocket) throw new Error('This Node runtime does not expose global WebSocket')
  return websocket
}

async function connectWebSocket(url: string): Promise<BufferedWebSocket> {
  const WebSocket = nativeWebSocket()
  const socket = new WebSocket(url)
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

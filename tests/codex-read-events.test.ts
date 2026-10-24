import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Socket } from 'node:net'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CodexReadEventObserver,
  NativeReadFrames,
  parseNativeReadEvent,
} from '../packages/local-server/src/codex-read-events.js'

const identity = { kind: 'chatgpt', accountId: 'test-account', userId: 'test-user' }
const host = 'local:' + 'b'.repeat(64)
const hash = createHash('sha256')
  .update(JSON.stringify(['chatgpt', identity.accountId, identity.userId]))
  .digest('hex')
const receipt = () => ({
  type: 'broadcast',
  method: 'thread-read-state-changed',
  version: 3,
  params: {
    conversationId: 'task-a',
    hostId: 'local',
    hasUnreadTurn: false,
    context: { identity, executionHostKey: host },
  },
})
function encode(value: unknown) {
  const body = Buffer.from(JSON.stringify(value)),
    frame = Buffer.alloc(4 + body.length)
  frame.writeUInt32LE(body.length)
  body.copy(frame, 4)
  return frame
}
async function until(condition: () => boolean) {
  const end = Date.now() + 2_000
  while (!condition()) {
    if (Date.now() > end) assert.fail('Timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('native receipt validates version, identity and local host without retaining account data', () => {
  assert.deepEqual(parseNativeReadEvent(receipt()), {
    sessionId: 'task-a',
    scope: `${hash}:${host}`,
    unread: false,
  })
  for (const change of [
    { version: 2 },
    { type: 'request' },
    { method: 'thread-stream-state-changed' },
    { params: { ...receipt().params, hostId: 'remote' } },
    { params: { ...receipt().params, hasUnreadTurn: 'false' } },
    { params: { ...receipt().params, context: {} } },
  ])
    assert.equal(parseNativeReadEvent({ ...receipt(), ...change }), undefined)
})

test('frame decoder handles split/coalesced frames and skips large unrelated payloads', () => {
  const messages: unknown[] = [],
    decoder = new NativeReadFrames((value) => messages.push(value))
  const first = encode(receipt()),
    large = encode({ unrelated: 'x'.repeat(128 * 1024) }),
    last = encode({ last: true })
  const stream = Buffer.concat([first, large, last])
  for (let i = 0; i < stream.length; i += 17) decoder.push(stream.subarray(i, i + 17))
  assert.deepEqual(messages, [receipt(), { last: true }])
  assert.throws(() => new NativeReadFrames(() => {}).push(Buffer.alloc(4)), /frame length/)
  const tooLarge = Buffer.alloc(4)
  tooLarge.writeUInt32LE(256 * 1024 * 1024 + 1)
  assert.throws(() => new NativeReadFrames(() => {}).push(tooLarge), /frame length/)
})

test('observer only initializes and declines ownership; reads broadcasts and safely reconnects', async (t) => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\codepulse-read-test-${randomUUID()}`
      : join(tmpdir(), `cp-${randomUUID()}.sock`)
  const server = createServer(),
    sockets: Socket[] = [],
    sent: Record<string, any>[] = [],
    events: unknown[] = []
  let connected = 0,
    reset = 0
  const observer = new CodexReadEventObserver({
    endpoint,
    reconnectMs: 10,
    onConnected: () => connected++,
  })
  t.after(async () => {
    observer.stop()
    sockets.forEach((socket) => socket.destroy())
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  server.on('connection', (socket) => {
    sockets.push(socket)
    const frames = new NativeReadFrames((value) => {
      const message = value as Record<string, any>
      sent.push(message)
      if (message.method === 'initialize')
        socket.write(
          encode({
            type: 'response',
            requestId: message.requestId,
            resultType: 'success',
            method: 'initialize',
            result: { clientId: 'observer' },
          }),
        )
    })
    socket.on('data', (chunk) => frames.push(chunk))
  })
  server.listen(endpoint)
  await once(server, 'listening')
  observer.start(
    (event) => events.push(event),
    () => reset++,
  )
  await until(() => connected === 1)
  const socket = sockets[0]!
  socket.write(
    Buffer.concat([
      encode({
        type: 'client-discovery-request',
        requestId: 'discovery',
        request: { method: 'thread-resume' },
      }),
      encode({ type: 'request', requestId: 'ownership', method: 'thread-resume' }),
      encode({ ...receipt(), targetClientIds: ['someone-else'] }),
      encode(receipt()),
    ]),
  )
  await until(() => events.length === 1 && sent.length === 3)
  assert.deepEqual(
    sent.map((message) => [message.type, message.method]),
    [
      ['request', 'initialize'],
      ['client-discovery-response', undefined],
      ['response', undefined],
    ],
  )
  assert.equal(sent[0]!.params.clientType, 'codepulse-read-observer')
  assert.deepEqual(sent[1], {
    type: 'client-discovery-response',
    requestId: 'discovery',
    response: { canHandle: false },
  })
  assert.equal(sent[2]!.resultType, 'error')
  socket.destroy()
  await until(() => connected === 2)
  assert.equal(reset, 1)
  observer.stop()
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(sockets.length, 2)
  assert.equal(events.length, 1)
})

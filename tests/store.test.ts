/// <reference lib="dom" />
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StatusSnapshot } from '@codepulse/shared'
import type { CodePulseApi } from '../apps/desktop/src/renderer/src/env.js'
import { useStore } from '../apps/desktop/src/renderer/src/store.js'
import { snapshotDataKey } from '../apps/desktop/src/renderer/src/lib/snapshotKey.js'

test('snapshotDataKey ignores updatedAt-only polling changes', () => {
  const first = {
    overall: 'running' as const,
    updatedAt: 100,
    agents: [
      {
        agentType: 'codex' as const,
        state: 'THINKING' as const,
        toolCallCount: 1,
        needPermission: false,
        needUserInput: false,
        activity: 'thinking',
        lastEventAt: 50,
        unread: false,
      },
    ],
  }
  const second = { ...first, updatedAt: 200 }

  assert.equal(snapshotDataKey(first), snapshotDataKey(second))
})

/**
 * Creates the preload methods needed by renderer initialization.
 *
 * @param syncSessions Injectable bootstrap request.
 * @param onStatus Injectable status-listener registration.
 * @returns Minimal test bridge without any native Electron process.
 */
function storeApi(
  syncSessions: CodePulseApi['syncSessions'],
  onStatus: CodePulseApi['onStatus'],
): CodePulseApi {
  return {
    syncSessions,
    getStatus: syncSessions,
    detectAgents: async () => [],
    getUpdate: async () => null,
    onStatus,
    onMute: () => () => undefined,
    onAgents: () => () => undefined,
    onUpdateAvailable: () => () => undefined,
    onUpdateProgress: () => () => undefined,
  } as unknown as CodePulseApi
}

test('renderer keeps pushed status when an older bootstrap response arrives later', async (t) => {
  const initial = useStore.getState()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let push!: (snapshot: StatusSnapshot) => void
  let resolveBootstrap!: (snapshot: StatusSnapshot) => void
  const bootstrap = new Promise<StatusSnapshot>((resolve) => {
    resolveBootstrap = resolve
  })
  const latest: StatusSnapshot = { overall: 'running', agents: [], updatedAt: 200 }
  const api = storeApi(
    () => {
      push(latest)
      return bootstrap
    },
    (callback) => {
      push = callback
      return () => undefined
    },
  )
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { codepulse: api } })
  const cleanup = useStore.getState().init()
  t.after(() => {
    cleanup()
    useStore.setState(initial, true)
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  assert.equal(useStore.getState().snapshot, latest)
  resolveBootstrap({ overall: 'idle', agents: [], updatedAt: 100 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(useStore.getState().snapshot, latest)
  assert.equal(useStore.getState().ready, true)
})

test('renderer ignores bootstrap work after its subscription is disposed', async (t) => {
  const initial = useStore.getState()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let release!: (snapshot: StatusSnapshot) => void
  const bootstrap = new Promise<StatusSnapshot>((resolve) => {
    release = resolve
  })
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      codepulse: storeApi(
        () => bootstrap,
        () => () => undefined,
      ),
    },
  })
  const cleanup = useStore.getState().init()
  t.after(() => {
    cleanup()
    useStore.setState(initial, true)
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  cleanup()
  const retained = useStore.getState()
  release({ overall: 'running', agents: [], updatedAt: 300 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(useStore.getState(), retained)
})

test('renderer serializes each incoming snapshot once and keeps timestamp-only updates inert', async (t) => {
  const initial = useStore.getState()
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let push!: (snapshot: StatusSnapshot) => void
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      codepulse: storeApi(
        async () => initial.snapshot,
        (callback) => {
          push = callback
          return () => undefined
        },
      ),
    },
  })
  const cleanup = useStore.getState().init()
  t.after(() => {
    cleanup()
    useStore.setState(initial, true)
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  let serializations = 0
  const measuredAgents = Object.assign([], {
    toJSON: () => {
      serializations += 1
      return []
    },
  })
  const snapshot: StatusSnapshot = { overall: 'running', agents: measuredAgents, updatedAt: 400 }
  push(snapshot)
  push({ ...snapshot, updatedAt: 500 })
  assert.equal(serializations, 2)
  assert.equal(useStore.getState().snapshot, snapshot)
})

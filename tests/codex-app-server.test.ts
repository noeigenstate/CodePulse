import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { StatusHub } from '@codepulse/core'
import {
  CodexAppServerQuotaService,
  createCodexAccountScope,
  normalizeCodexRateLimitsResponse,
  resolveCodexAppServerCommand,
  type CodexAppServerChild,
  type CodexAppServerQuotaSnapshot,
} from '../packages/local-server/src/codex-app-server.js'

const RATE_LIMITS = {
  limitId: 'codex',
  limitName: 'Codex',
  primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 41, windowDurationMins: 10_080, resetsAt: 1_800_500_000 },
  credits: null,
  individualLimit: null,
  spendControlReached: null,
  planType: 'pro',
  rateLimitReachedType: null,
}

interface FakeQuotaUsage {
  /** Main five-hour usage; omission produces a sparse response. */
  fiveHour?: number
  /** Main weekly usage; omission produces a sparse response. */
  sevenDay?: number
  /** Optional five-hour usage for the Codex Spark bucket. */
  sparkFiveHour?: number
  /** Optional weekly usage for the Codex Spark bucket. */
  sparkSevenDay?: number
}

/**
 * Builds one deterministic App Server quota-read result.
 *
 * @param usage Rolling-window percentages included in the response.
 * @returns Protocol result containing the main and optional Spark buckets.
 */
function fakeQuotaResponse(usage: FakeQuotaUsage): Record<string, unknown> {
  const rateLimits = {
    ...RATE_LIMITS,
    primary:
      usage.fiveHour === undefined ? null : { ...RATE_LIMITS.primary, usedPercent: usage.fiveHour },
    secondary:
      usage.sevenDay === undefined
        ? null
        : { ...RATE_LIMITS.secondary, usedPercent: usage.sevenDay },
  }
  const rateLimitsByLimitId: Record<string, unknown> = { codex: rateLimits }
  if (usage.sparkFiveHour !== undefined || usage.sparkSevenDay !== undefined) {
    rateLimitsByLimitId.codex_bengalfox = {
      ...RATE_LIMITS,
      limitId: 'codex_bengalfox',
      limitName: 'Codex Spark',
      primary:
        usage.sparkFiveHour === undefined
          ? null
          : { ...RATE_LIMITS.primary, usedPercent: usage.sparkFiveHour },
      secondary:
        usage.sparkSevenDay === undefined
          ? null
          : { ...RATE_LIMITS.secondary, usedPercent: usage.sparkSevenDay },
    }
  }
  return {
    rateLimits,
    rateLimitsByLimitId,
    rateLimitResetCredits: null,
  }
}

/** Callbacks that project service snapshots through production quota stability. */
interface HubQuotaBridge {
  /** Applies one official account boundary to Hub. */
  onAccountScope: (scope: string) => void
  /** Applies one App Server quota observation to Hub. */
  onSnapshot: (snapshot: CodexAppServerQuotaSnapshot) => void
}

/**
 * Creates the account-aware bridge used by the local server around StatusHub.
 *
 * @param hub Hub whose accepted Codex quota should be inspected.
 * @returns Service callbacks that preserve physical-vs-notification metadata.
 */
function createHubQuotaBridge(hub: StatusHub): HubQuotaBridge {
  let accountScope: string | undefined
  let sequence = 0
  return {
    onAccountScope: (scope) => {
      if (scope === accountScope) return
      accountScope = scope
      hub.invalidateAgentQuota('codex')
    },
    onSnapshot: (snapshot) => {
      sequence += 1
      const id = `app-server-test:${sequence}`
      hub.observeQuota({
        id,
        source: 'codex',
        eventType: 'token_snapshot',
        timestamp: snapshot.updatedAt,
        token: snapshot.token,
        internal: {
          quotaRefresh: true,
          usageSampleId: id,
          quotaObservationSource: snapshot.source,
        },
      })
    },
  }
}

test('normalizeCodexRateLimitsResponse maps the main and named quota buckets', () => {
  const token = normalizeCodexRateLimitsResponse(
    {
      rateLimits: RATE_LIMITS,
      rateLimitsByLimitId: {
        codex: RATE_LIMITS,
        codex_bengalfox: {
          ...RATE_LIMITS,
          limitId: 'codex_bengalfox',
          limitName: 'Codex Spark',
          primary: { usedPercent: 7, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        },
      },
      rateLimitResetCredits: null,
    },
    123_000,
  )

  assert.equal(token?.accuracy, 'exact')
  assert.equal(token?.rateLimits?.fiveHour?.usedPercent, 23)
  assert.equal(token?.rateLimits?.sevenDay?.usedPercent, 41)
  assert.equal(token?.quotaBuckets?.codex?.updatedAt, 123_000)
  assert.equal(token?.quotaBuckets?.codex_bengalfox?.rateLimits?.fiveHour?.usedPercent, 7)
})

test('createCodexAccountScope is stable in-process and never contains account metadata', () => {
  const first = createCodexAccountScope({
    type: 'chatgpt',
    email: 'Owner@Example.com',
    planType: 'pro',
  })
  const same = createCodexAccountScope({
    type: 'chatgpt',
    email: 'owner@example.com',
    planType: 'pro',
  })
  const different = createCodexAccountScope({
    type: 'chatgpt',
    email: 'other@example.com',
    planType: 'pro',
  })

  assert.equal(first, same)
  assert.notEqual(first, different)
  assert.equal(first.includes('owner'), false)
  assert.match(first, /^codex:[A-Za-z0-9_-]{24}$/)
})

test('resolveCodexAppServerCommand uses trusted Windows shells and CODEX_CLI_PATH', () => {
  assert.deepEqual(
    resolveCodexAppServerCommand(
      {
        CODEX_CLI_PATH: 'C:\\Program Files\\Codex\\codex.cmd',
        SystemRoot: 'C:\\Windows',
      },
      'win32',
    ),
    {
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Program Files\\Codex\\codex.cmd" app-server --stdio"'],
    },
  )

  const powershell = resolveCodexAppServerCommand(
    {
      CODEX_CLI_PATH: 'D:\\nodejs\\codex.ps1',
      SystemRoot: 'C:\\Windows',
    },
    'win32',
  )
  assert.equal(powershell.command, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  assert.deepEqual(powershell.args.slice(-3), ['D:\\nodejs\\codex.ps1', 'app-server', '--stdio'])
  assert.throws(
    () =>
      resolveCodexAppServerCommand(
        { CODEX_CLI_PATH: 'C:\\Codex & malware\\codex.cmd', SystemRoot: 'C:\\Windows' },
        'win32',
      ),
    /Unsafe Windows Codex shim path/,
  )
})

test('service emits each burst read immediately and returns the newest result', async () => {
  const server = new FakeCodexAppServer([11, 22, 33, 33, 33, 33])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const accountScopes: string[] = []
  let windowsVerbatimArguments: boolean | undefined
  let spawnedPath: string | undefined
  let retainedMixedCasePath = false
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => accountScopes.push(scope),
    spawnProcess: (_command, _args, options) => {
      windowsVerbatimArguments = options.windowsVerbatimArguments
      spawnedPath = options.env.PATH
      retainedMixedCasePath = Object.keys(options.env).some((key) => key === 'Path')
      return server.spawn()
    },
    burstDelaysMs: [0, 5, 5],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    now: () => 456_000,
    platform: 'win32',
    env: {
      CODEX_CLI_PATH: 'C:\\tools\\codex.cmd',
      SystemRoot: 'C:\\Windows',
      Path: 'C:\\tools;C:\\Windows\\System32',
    },
  })

  await service.start()
  assert.equal(service.getProcessId(), server.pid)
  assert.equal(snapshots.length, 1)
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  const [second, coalesced] = await Promise.all([service.refresh(), service.refresh()])
  service.stop()
  assert.equal(service.getProcessId(), undefined)

  assert.equal(server.spawnCount, 1)
  assert.equal(windowsVerbatimArguments, true)
  assert.equal(spawnedPath, 'C:\\tools;C:\\Windows\\System32')
  assert.equal(retainedMixedCasePath, false)
  assert.equal(server.methods.filter((method) => method === 'initialize').length, 1)
  assert.equal(server.methods.filter((method) => method === 'account/read').length, 2)
  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 6)
  assert.equal(server.methods.includes('initialized'), true)
  assert.equal(
    server.methods.some((method) => method.includes('thread/')),
    false,
  )
  assert.equal(
    server.methods.some((method) => method.includes('turn/')),
    false,
  )
  assert.deepEqual(
    snapshots.slice(0, 3).map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [11, 22, 33],
  )
  assert.equal(second?.token.rateLimits?.fiveHour?.usedPercent, 33)
  assert.equal(coalesced?.token.rateLimits?.fiveHour?.usedPercent, 33)
  assert.equal(accountScopes.length, 2)
  assert.equal(accountScopes[0], accountScopes[1])
  assert.equal(
    snapshots.every((snapshot) => !JSON.stringify(snapshot).includes('@example.com')),
    true,
  )
})

test('service continues a three-read burst after one transient quota failure', async () => {
  const server = new FakeCodexAppServer([11, 22, 33])
  server.failedQuotaReads.add(0)
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 3)
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [22, 33],
  )
})

test('service extends a lower quota burst to five physical observations', async () => {
  const server = new FakeCodexAppServer([60, 60, 60, 10, 11, 12, 13, 14])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  await service.refresh()
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 8)
  assert.deepEqual(
    snapshots.slice(-5).map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [10, 11, 12, 13, 14],
  )
})

test('service restarts lower confirmation while official usage is still decreasing', async () => {
  const server = new FakeCodexAppServer([60, 60, 60, 10, 9, 8, 7, 6, 6, 6, 6, 6])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  await service.refresh()
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 12)
  assert.deepEqual(
    snapshots.slice(-5).map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [6, 6, 6, 6, 6],
  )
})

test('service confirms sparse lower quota independently for each rolling window', async () => {
  const server = new FakeCodexAppServer([40])
  const responses = [
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 10, sevenDay: 10 },
    { sevenDay: 10 },
    { sevenDay: 10 },
    { sevenDay: 10 },
    { sevenDay: 10 },
    { fiveHour: 10, sevenDay: 10 },
    { fiveHour: 10, sevenDay: 10 },
    { fiveHour: 10, sevenDay: 10 },
    { fiveHour: 10, sevenDay: 10 },
  ]
  responses.forEach((usage, index) => {
    server.quotaResponseOverrides.set(index, fakeQuotaResponse(usage))
  })
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  await service.refresh()
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 12)
  assert.deepEqual(
    snapshots.slice(3).map((snapshot) => ({
      fiveHour: snapshot.token.rateLimits?.fiveHour?.usedPercent,
      sevenDay: snapshot.token.rateLimits?.sevenDay?.usedPercent,
    })),
    [
      { fiveHour: 10, sevenDay: 10 },
      { fiveHour: undefined, sevenDay: 10 },
      { fiveHour: undefined, sevenDay: 10 },
      { fiveHour: undefined, sevenDay: 10 },
      { fiveHour: undefined, sevenDay: 10 },
      { fiveHour: 10, sevenDay: 10 },
      { fiveHour: 10, sevenDay: 10 },
      { fiveHour: 10, sevenDay: 10 },
      { fiveHour: 10, sevenDay: 10 },
    ],
  )
})

test('lower notification remains pending when every physical read omits its window', async () => {
  const server = new FakeCodexAppServer([40])
  for (let index = 0; index < 3; index += 1) {
    server.quotaResponseOverrides.set(index, fakeQuotaResponse({ fiveHour: 40, sevenDay: 70 }))
  }
  for (let index = 3; index < 16; index += 1) {
    server.quotaResponseOverrides.set(index, fakeQuotaResponse({ fiveHour: 40 }))
  }
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  const lowerWeeklyNotification = {
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        primary: null,
        secondary: { ...RATE_LIMITS.secondary, usedPercent: 10 },
      },
    },
  }
  server.notify(lowerWeeklyNotification)
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 16,
    3_000,
  )
  const notificationsAfterFirstHint = snapshots.filter(
    (snapshot) => snapshot.source === 'notification',
  ).length
  server.notify(lowerWeeklyNotification)
  await new Promise((resolve) => setImmediate(resolve))
  const notificationsAfterSecondHint = snapshots.filter(
    (snapshot) => snapshot.source === 'notification',
  ).length
  service.stop()

  assert.equal(notificationsAfterFirstHint, 1)
  assert.equal(notificationsAfterSecondHint, 1)
})

test('one burst confirms four sparse main and Spark windows round-robin', async () => {
  const server = new FakeCodexAppServer([40])
  const baseline = {
    fiveHour: 40,
    sevenDay: 70,
    sparkFiveHour: 30,
    sparkSevenDay: 60,
  }
  for (let index = 0; index < 3; index += 1) {
    server.quotaResponseOverrides.set(index, fakeQuotaResponse(baseline))
  }
  const sparseRound = [
    { fiveHour: 10 },
    { sevenDay: 10 },
    { sparkFiveHour: 10 },
    { sparkSevenDay: 10 },
  ]
  for (let index = 0; index < 20; index += 1) {
    server.quotaResponseOverrides.set(3 + index, fakeQuotaResponse(sparseRound[index % 4]!))
  }
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  server.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        primary: { ...RATE_LIMITS.primary, usedPercent: 10 },
        secondary: { ...RATE_LIMITS.secondary, usedPercent: 10 },
      },
    },
  })
  server.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        limitId: 'codex_bengalfox',
        limitName: 'Codex Spark',
        primary: { ...RATE_LIMITS.primary, usedPercent: 10 },
        secondary: { ...RATE_LIMITS.secondary, usedPercent: 10 },
      },
    },
  })
  await service.refresh()
  service.stop()

  const physicalConfirmationReads = snapshots
    .filter((snapshot) => snapshot.source === 'read')
    .slice(3)
  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 23)
  assert.equal(physicalConfirmationReads.length, 20)
  assert.equal(
    physicalConfirmationReads.filter(
      (snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent === 10,
    ).length,
    5,
  )
  assert.equal(
    physicalConfirmationReads.filter(
      (snapshot) =>
        snapshot.token.quotaBuckets?.codex_bengalfox?.rateLimits?.sevenDay?.usedPercent === 10,
    ).length,
    5,
  )
})

test('pending confirmation adopts a newly observed family before its usage decreases', async () => {
  const server = new FakeCodexAppServer([40])
  const responses = [
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 40, sevenDay: 70 },
    { fiveHour: 10 },
    { fiveHour: 10, sparkFiveHour: 20 },
    { fiveHour: 40, sparkFiveHour: 10 },
    { sparkFiveHour: 10 },
    { sparkFiveHour: 10 },
    { sparkFiveHour: 10 },
    { sparkFiveHour: 10 },
  ]
  responses.forEach((usage, index) => {
    server.quotaResponseOverrides.set(index, fakeQuotaResponse(usage))
  })
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  await service.refresh()
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 10)
  assert.equal(
    snapshots.filter(
      (snapshot) =>
        snapshot.token.quotaBuckets?.codex_bengalfox?.rateLimits?.fiveHour?.usedPercent === 10,
    ).length,
    5,
  )
})

test('a notification after the fifth response queues one trailing physical burst', async () => {
  const server = new FakeCodexAppServer([60, 60, 60, 10, 11, 12, 13, 14, 60, 60, 60])
  server.notificationsAfterQuotaRead.set(7, [
    {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          ...RATE_LIMITS,
          primary: { ...RATE_LIMITS.primary, usedPercent: 14 },
        },
      },
    },
  ])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  await service.refresh()
  service.stop()

  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 11)
  assert.equal(server.methods.filter((method) => method === 'account/read').length, 3)
  assert.equal(snapshots.filter((snapshot) => snapshot.source === 'notification').length, 0)
  assert.deepEqual(
    snapshots.slice(3, 8).map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [10, 11, 12, 13, 14],
  )
  assert.deepEqual(
    snapshots.slice(-3).map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [60, 60, 60],
  )
})

test('account/updated creates a fresh opaque boundary for API-key accounts', async () => {
  const server = new FakeCodexAppServer([20, 21, 22])
  server.account = { type: 'apiKey' }
  const scopes: string[] = []
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => 'stable-auth-revision',
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  const originalScope = snapshots.at(-1)?.accountScope
  server.notify({ method: 'account/updated', params: { authMode: 'apikey' } })
  await waitUntil(
    () =>
      server.methods.filter((method) => method === 'account/rateLimits/read').length >= 6 &&
      snapshots.at(-1)?.accountScope !== originalScope,
    100,
  )
  service.stop()

  const updatedScope = snapshots.at(-1)?.accountScope
  assert.match(originalScope ?? '', /^codex:/)
  assert.match(updatedScope ?? '', /^codex:/)
  assert.notEqual(updatedScope, originalScope)
  assert.equal(new Set(scopes).size, 2)
})

test('account/updated advances the boundary even when the replacement account read fails', async () => {
  const server = new FakeCodexAppServer([20])
  server.account = { type: 'apiKey' }
  const scopes: string[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: () => undefined,
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    restartDelayMs: 1_000,
    credentialRevisionReader: async () => 'stable-auth-revision',
    platform: 'linux',
  })

  await service.start()
  server.failedAccountReads.add(1)
  server.notify({ method: 'account/updated' })
  await waitUntil(() => scopes.length >= 2, 100)
  service.stop()

  assert.equal(new Set(scopes).size, 2)
  assert.notEqual(scopes[0], scopes[1])
})

test('consecutive account updates each emit one stable provisional scope', async () => {
  const server = new FakeCodexAppServer([20])
  server.account = { type: 'apiKey' }
  const scopes: string[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: () => undefined,
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => 'stable-auth-revision',
    platform: 'linux',
  })

  await service.start()
  server.notify({ method: 'account/updated' })
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/read').length >= 2,
    100,
  )
  server.notify({ method: 'account/updated' })
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/read').length >= 3,
    100,
  )
  service.stop()

  assert.equal(new Set(scopes).size, 3)
})

test('API-key replacement while disconnected rotates scope and drops the old snapshot', async () => {
  const original = new FakeCodexAppServer([64])
  original.account = { type: 'apiKey' }
  const replacement = new FakeCodexAppServer([4])
  replacement.account = { type: 'apiKey' }
  replacement.emptyQuota = true
  const scopes: string[] = []
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let spawnCount = 0
  let credentialRevision = 'auth-a'
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: () => {
      spawnCount += 1
      return spawnCount === 1 ? original.spawn() : replacement.spawn()
    },
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    restartDelayMs: 1,
    credentialRevisionReader: async () => credentialRevision,
    platform: 'linux',
  })

  await service.start()
  const originalScope = snapshots.at(-1)?.accountScope
  credentialRevision = 'auth-b'
  original.exit()
  await waitUntil(
    () => replacement.methods.filter((method) => method === 'account/rateLimits/read').length >= 1,
    100,
  )
  // Joining the serialized refresh worker proves the replacement account's
  // credential binding completed; merely observing a written request races
  // the client's post-response revision validation.
  await service.refresh()
  replacement.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        primary: { ...RATE_LIMITS.primary, usedPercent: 4 },
        secondary: null,
      },
    },
  })
  service.stop()

  const replacementSnapshot = snapshots.find((snapshot) => snapshot.source === 'notification')
  assert.equal(spawnCount, 2)
  assert.match(originalScope ?? '', /^codex:/)
  assert.match(replacementSnapshot?.accountScope ?? '', /^codex:/)
  assert.notEqual(replacementSnapshot?.accountScope, originalScope)
  assert.equal(replacementSnapshot?.token.rateLimits?.fiveHour?.usedPercent, 4)
  assert.equal(replacementSnapshot?.token.rateLimits?.sevenDay, undefined)
  assert.equal(new Set(scopes).size, 2)
})

test('ordinary API-key reconnect keeps the account scope when credentials are unchanged', async () => {
  const original = new FakeCodexAppServer([64])
  const replacement = new FakeCodexAppServer([64])
  original.account = { type: 'apiKey' }
  replacement.account = { type: 'apiKey' }
  const scopes: string[] = []
  let spawnCount = 0
  const service = new CodexAppServerQuotaService({
    onSnapshot: () => undefined,
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: () => (spawnCount++ === 0 ? original.spawn() : replacement.spawn()),
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    restartDelayMs: 1,
    credentialRevisionReader: async () => 'same-auth-revision',
    platform: 'linux',
  })

  await service.start()
  original.exit()
  await waitUntil(
    () => replacement.methods.filter((method) => method === 'account/rateLimits/read').length >= 1,
    100,
  )
  service.stop()

  assert.equal(new Set(scopes).size, 1)
})

test('connected API-key credential replacement rotates scope before accepting lower quota', async () => {
  const server = new FakeCodexAppServer([70, 70, 70, 10, 10, 10, 10, 10])
  server.account = { type: 'apiKey' }
  const hub = new StatusHub({ sessionThrottleMs: 0 })
  const bridge = createHubQuotaBridge(hub)
  const scopes: string[] = []
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let credentialRevision = 'auth-a'
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => {
      snapshots.push(snapshot)
      bridge.onSnapshot(snapshot)
    },
    onAccountScope: (scope) => {
      scopes.push(scope)
      bridge.onAccountScope(scope)
    },
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => credentialRevision,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  const originalScope = snapshots.at(-1)?.accountScope
  credentialRevision = 'auth-b'
  await service.refresh()
  service.stop()

  const codex = hub.snapshot().agents.find((agent) => agent.agentType === 'codex')
  const replacementSnapshots = snapshots.filter(
    (snapshot) => snapshot.accountScope !== originalScope,
  )
  assert.equal(new Set(scopes).size, 2)
  assert.equal(replacementSnapshots[0]?.token.rateLimits?.fiveHour?.usedPercent, 10)
  assert.equal(codex?.token?.rateLimits?.fiveHour?.usedPercent, 10)
})

test('credential replacement during a quota request discards the stale account response', async () => {
  const server = new FakeCodexAppServer([70, 10, 10, 10])
  server.account = { type: 'apiKey' }
  server.deferredQuotaReads.add(0)
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const scopes: string[] = []
  let credentialRevision = 'auth-a'
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => credentialRevision,
    platform: 'linux',
  })

  const started = service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 1,
    100,
  )
  credentialRevision = 'auth-b'
  server.releaseQuotaRead(0)
  await started
  await waitUntil(() => snapshots.length > 0, 100)
  service.stop()

  assert.equal(new Set(scopes).size, 2)
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [10],
  )
})

test('every opaque burst read gates bundled notifications until credential validation', async () => {
  const server = new FakeCodexAppServer([70, 90, 10, 10])
  server.account = { type: 'apiKey' }
  server.deferredQuotaReads.add(1)
  server.notificationsAfterQuotaRead.set(1, [
    {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          ...RATE_LIMITS,
          primary: { ...RATE_LIMITS.primary, usedPercent: 95 },
          secondary: null,
        },
      },
    },
  ])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const scopes: string[] = []
  let credentialRevision = 'auth-a'
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => credentialRevision,
    platform: 'linux',
  })

  const started = service.start()
  await withTestDeadline(server.waitForQuotaRead(1), 100)
  await started
  const originalScope = snapshots.at(-1)?.accountScope
  credentialRevision = 'auth-b'
  const drained = service.refresh()
  server.releaseQuotaRead(1)
  await withTestDeadline(drained, 100)
  service.stop()

  const originalAccountSnapshots = snapshots.filter(
    (snapshot) => snapshot.accountScope === originalScope,
  )
  assert.deepEqual(
    originalAccountSnapshots.map((snapshot) => [
      snapshot.source,
      snapshot.token.rateLimits?.fiveHour?.usedPercent,
    ]),
    [['read', 70]],
    'the changed-key response and bundled notification must not escape under the old scope',
  )
  assert.equal(new Set(scopes).size, 2)
  assert.equal(
    snapshots.some(
      (snapshot) =>
        snapshot.accountScope !== originalScope &&
        snapshot.token.rateLimits?.fiveHour?.usedPercent === 10,
    ),
    true,
    'a clean retry may publish only after adopting the replacement credential scope',
  )
})

for (const refreshPath of ['burst', 'refreshOnce'] as const) {
  test(`opaque ${refreshPath} binds a post-response revision to the previously verified account`, async () => {
    const server = new FakeCodexAppServer([70, 90, 10])
    server.account = { type: 'apiKey' }
    server.deferredQuotaReads.add(1)
    const snapshots: CodexAppServerQuotaSnapshot[] = []
    const scopes: string[] = []
    let readingReplacement = false
    let replacementRevisionReads = 0
    const service = new CodexAppServerQuotaService({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      onAccountScope: (scope) => scopes.push(scope),
      spawnProcess: server.spawn,
      burstDelaysMs: [0],
      pollIntervalMs: 0,
      requestTimeoutMs: 100,
      credentialRevisionReader: async () => {
        if (!readingReplacement) return 'auth-a'
        replacementRevisionReads += 1
        return replacementRevisionReads === 1 ? undefined : 'auth-b'
      },
      platform: 'linux',
    })

    await service.start()
    await new Promise((resolve) => setImmediate(resolve))
    const originalScope = snapshots.at(-1)?.accountScope
    readingReplacement = true
    const refreshPromise =
      refreshPath === 'burst'
        ? service.refresh()
        : (
            service as unknown as {
              refreshOnce: () => Promise<CodexAppServerQuotaSnapshot | undefined>
            }
          ).refreshOnce()
    await waitUntil(
      () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 2,
      100,
    )
    server.releaseQuotaRead(1)
    await refreshPromise
    service.stop()

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
      [70, 10],
      'the ambiguous 90% response must not escape under the old account scope',
    )
    assert.notEqual(snapshots.at(-1)?.accountScope, originalScope)
    assert.equal(new Set(scopes).size, 2)
  })
}

test('verified opaque account suppresses a response when its post-read revision is unavailable', async () => {
  const server = new FakeCodexAppServer([70, 90])
  server.account = { type: 'apiKey' }
  server.deferredQuotaReads.add(1)
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const scopes: string[] = []
  let revisionAvailable = true
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => (revisionAvailable ? 'auth-a' : undefined),
    platform: 'linux',
  })

  await service.start()
  await new Promise((resolve) => setImmediate(resolve))
  revisionAvailable = false
  const refreshed = service.refresh()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 2,
    100,
  )
  server.releaseQuotaRead(1)
  await refreshed
  service.stop()

  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [70],
  )
  assert.equal(new Set(scopes).size, 1, 'an unavailable revision must not invent a boundary')
})

test('opaque account boundary suppresses notifications until credential binding is verified', async () => {
  const server = new FakeCodexAppServer([70])
  server.account = { type: 'apiKey' }
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const scopes: string[] = []
  let revisionAvailable = true
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => (revisionAvailable ? 'auth-a' : undefined),
    platform: 'linux',
  })

  await service.start()
  await service.refresh()
  const originalScope = snapshots.at(-1)?.accountScope
  const snapshotCountBeforeBoundary = snapshots.length
  const nextReadIndex = server.methods.filter(
    (method) => method === 'account/rateLimits/read',
  ).length
  server.notificationsAfterQuotaRead.set(nextReadIndex, [
    {
      method: 'account/rateLimits/updated',
      params: {
        rateLimits: {
          ...RATE_LIMITS,
          primary: { ...RATE_LIMITS.primary, usedPercent: 5 },
          secondary: null,
        },
      },
    },
  ])
  revisionAvailable = false
  server.notify({ method: 'account/updated' })
  await service.refresh()
  service.stop()

  assert.equal(new Set(scopes).size, 2)
  assert.notEqual(scopes.at(-1), originalScope)
  assert.equal(
    snapshots.length,
    snapshotCountBeforeBoundary,
    'neither an unbound physical response nor its notification may be published',
  )
  assert.equal(
    snapshots
      .slice(snapshotCountBeforeBoundary)
      .some((snapshot) => snapshot.source === 'notification'),
    false,
  )
})

test('service ignores quota notifications after it stops', async () => {
  const server = new FakeCodexAppServer([20])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  service.stop()
  const countAtStop = snapshots.length
  server.notify({
    method: 'account/rateLimits/updated',
    params: { rateLimits: RATE_LIMITS },
  })
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(snapshots.length, countAtStop)
})

test('service merges account/rateLimits/updated without clearing the weekly window', async () => {
  const server = new FakeCodexAppServer([20, 20, 20, 29])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  server.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        primary: { usedPercent: 29, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: null,
      },
    },
  })
  await new Promise((resolve) => setImmediate(resolve))
  service.stop()

  const notification = snapshots.find((snapshot) => snapshot.source === 'notification')
  assert.equal(notification?.source, 'notification')
  assert.equal(notification?.token.rateLimits?.fiveHour?.usedPercent, 29)
  assert.equal(notification?.token.rateLimits?.sevenDay?.usedPercent, 41)
  assert.equal(server.methods.filter((method) => method === 'account/rateLimits/read').length, 4)
  assert.equal(server.methods.filter((method) => method === 'account/read').length, 2)
})

test('pending weekly reset still publishes five-hour and Spark increases immediately', async () => {
  const server = new FakeCodexAppServer([20])
  for (let index = 0; index < 3; index += 1) {
    server.quotaResponseOverrides.set(
      index,
      fakeQuotaResponse({ fiveHour: 20, sevenDay: 70, sparkFiveHour: 5 }),
    )
  }
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: server.spawn,
    burstDelaysMs: [0, 0, 0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(
    () => server.methods.filter((method) => method === 'account/rateLimits/read').length === 3,
    100,
  )
  server.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        primary: { ...RATE_LIMITS.primary, usedPercent: 25 },
        secondary: { ...RATE_LIMITS.secondary, usedPercent: 10 },
      },
    },
  })
  server.notify({
    method: 'account/rateLimits/updated',
    params: {
      rateLimits: {
        ...RATE_LIMITS,
        limitId: 'codex_bengalfox',
        limitName: 'Codex Spark',
        primary: { ...RATE_LIMITS.primary, usedPercent: 8 },
        secondary: null,
      },
    },
  })

  const notifications = snapshots.filter((snapshot) => snapshot.source === 'notification')
  const newest = notifications.at(-1)?.token
  service.stop()

  assert.equal(notifications.length, 2)
  assert.equal(newest?.rateLimits?.fiveHour?.usedPercent, 25)
  assert.equal(newest?.rateLimits?.sevenDay?.usedPercent, 70)
  assert.equal(newest?.quotaBuckets?.codex_bengalfox?.rateLimits?.fiveHour?.usedPercent, 8)
})

test('service reports account scope even when quota is temporarily unavailable', async () => {
  const server = new FakeCodexAppServer([20])
  server.emptyQuota = true
  const scopes: string[] = []
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    onAccountScope: (scope) => scopes.push(scope),
    spawnProcess: server.spawn,
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  await service.start()
  service.stop()

  assert.equal(scopes.length, 1)
  assert.match(scopes[0] ?? '', /^codex:/)
  assert.equal(snapshots.length, 0)
})

test('service resolves a failed start and reconnects in the background', async () => {
  const healthy = new FakeCodexAppServer([38])
  const silent = createSilentChild()
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let spawns = 0
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: () => {
      spawns += 1
      return spawns === 1 ? silent : healthy.spawn()
    },
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 5,
    restartDelayMs: 1,
    platform: 'linux',
  })

  await withTestDeadline(service.start(), 100)
  await waitUntil(() => snapshots.length > 0, 100)
  service.stop()

  assert.equal(spawns, 2)
  assert.equal(snapshots[0]?.token.rateLimits?.fiveHour?.usedPercent, 38)
})

test('service discards a child whose initialize request is rejected', async () => {
  const rejected = new FakeCodexAppServer([1])
  rejected.failInitialize = true
  const healthy = new FakeCodexAppServer([44])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let spawns = 0
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: () => {
      spawns += 1
      return spawns === 1 ? rejected.spawn() : healthy.spawn()
    },
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    restartDelayMs: 1,
    platform: 'linux',
  })

  await service.start()
  await waitUntil(() => snapshots.length > 0, 100)
  service.stop()

  assert.equal(spawns, 2)
  assert.equal(snapshots[0]?.token.rateLimits?.fiveHour?.usedPercent, 44)
})

test('service isolates stopped credential work from a rapid restart', async () => {
  const first = new FakeCodexAppServer([70])
  const replacement = new FakeCodexAppServer([7])
  first.account = { type: 'apiKey' }
  replacement.account = { type: 'apiKey' }
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let spawnCount = 0
  let credentialReads = 0
  let releaseFirstCredential: (() => void) | undefined
  const firstCredential = new Promise<void>((resolve) => {
    releaseFirstCredential = resolve
  })
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: () => (spawnCount++ === 0 ? first.spawn() : replacement.spawn()),
    burstDelaysMs: [0],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    credentialRevisionReader: async () => {
      credentialReads += 1
      if (credentialReads === 1) await firstCredential
      return credentialReads === 1 ? 'old-auth' : 'new-auth'
    },
    platform: 'linux',
  })

  const firstStart = service.start()
  await waitUntil(
    () => first.methods.filter((method) => method === 'account/read').length === 1,
    100,
  )
  service.stop()
  const replacementStart = service.start()
  releaseFirstCredential?.()
  await Promise.all([firstStart, replacementStart])
  await waitUntil(() => snapshots.length > 0, 100)
  service.stop()

  assert.equal(spawnCount, 2)
  assert.ok(first.killCount >= 1, 'the stopped child must be terminated')
  assert.deepEqual(
    snapshots.map((snapshot) => snapshot.token.rateLimits?.fiveHour?.usedPercent),
    [7],
  )
})

test('a stale delayed burst cannot clear lower confirmation in a restarted lifetime', async () => {
  const first = new FakeCodexAppServer([60, 60, 60])
  const replacement = new FakeCodexAppServer([60, 10, 10, 10, 10, 10])
  const snapshots: CodexAppServerQuotaSnapshot[] = []
  let spawnCount = 0
  const service = new CodexAppServerQuotaService({
    onSnapshot: (snapshot) => snapshots.push(snapshot),
    spawnProcess: () => (spawnCount++ === 0 ? first.spawn() : replacement.spawn()),
    burstDelaysMs: [0, 40, 40],
    pollIntervalMs: 0,
    requestTimeoutMs: 100,
    platform: 'linux',
  })

  const oldStart = service.start()
  await waitUntil(
    () => first.methods.filter((method) => method === 'account/rateLimits/read').length === 1,
    100,
  )
  service.stop()
  const restarted = service.start()
  await Promise.all([oldStart, restarted])
  await waitUntil(
    () => replacement.methods.filter((method) => method === 'account/rateLimits/read').length >= 6,
    1_000,
  )
  service.stop()

  assert.equal(spawnCount, 2)
  assert.equal(snapshots.at(-1)?.token.rateLimits?.fiveHour?.usedPercent, 10)
  assert.equal(
    replacement.methods.filter((method) => method === 'account/rateLimits/read').length,
    6,
    'the restarted lower sequence must complete all five physical confirmations',
  )
})

/** In-memory JSONL server used to verify the client without invoking Codex. */
class FakeCodexAppServer {
  /** Stable fake operating-system identifier exposed by spawned children. */
  readonly pid = 42_424
  readonly methods: string[] = []
  readonly failedQuotaReads = new Set<number>()
  readonly failedAccountReads = new Set<number>()
  /** Full quota results substituted for selected physical-read indexes. */
  readonly quotaResponseOverrides = new Map<number, unknown>()
  /** Notifications appended to the same stdout chunk as a selected response. */
  readonly notificationsAfterQuotaRead = new Map<number, readonly unknown[]>()
  /** Quota read indexes held until a test explicitly releases their response. */
  readonly deferredQuotaReads = new Set<number>()
  spawnCount = 0
  killCount = 0
  emptyQuota = false
  failInitialize = false
  account: Record<string, unknown> = {
    type: 'chatgpt',
    email: 'owner@example.com',
    planType: 'pro',
  }
  private readonly stdout = new PassThrough()
  private readonly childEvents = new EventEmitter()
  private input = ''
  private readIndex = 0
  private accountReadIndex = 0
  private readonly deferredQuotaResponses = new Map<number, () => void>()
  private readonly quotaReadWaiters = new Map<number, Set<() => void>>()

  /**
   * Creates a fake with a repeating sequence of five-hour percentages.
   *
   * @param usageSequence Percentages returned by successive quota reads.
   */
  constructor(private readonly usageSequence: readonly number[]) {}

  /**
   * Spawn seam compatible with {@link CodexAppServerQuotaService}.
   *
   * @returns An in-memory child-process adapter.
   */
  readonly spawn = (): CodexAppServerChild => {
    this.spawnCount += 1
    const stdin = new PassThrough()
    stdin.on('data', (chunk: Buffer) => this.consume(chunk.toString('utf8')))
    return {
      pid: this.pid,
      stdin,
      stdout: this.stdout as unknown as CodexAppServerChild['stdout'],
      stderr: new PassThrough() as unknown as CodexAppServerChild['stderr'],
      on: (event, listener) => {
        this.childEvents.on(event, listener)
        return this.child as CodexAppServerChild
      },
      kill: () => {
        this.killCount += 1
        return true
      },
    }
  }

  /**
   * Emits one App Server notification.
   *
   * @param message Notification frame to emit.
   */
  notify(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  /**
   * Releases a quota response previously held by {@link deferredQuotaReads}.
   *
   * @param readIndex Zero-based physical quota-read index to release.
   */
  releaseQuotaRead(readIndex: number): void {
    this.deferredQuotaResponses.get(readIndex)?.()
  }

  /**
   * Waits until the client issues a specific physical quota read.
   *
   * @param readIndex Zero-based physical quota-read index to observe.
   * @returns A promise resolved synchronously when that request is parsed.
   */
  waitForQuotaRead(readIndex: number): Promise<void> {
    if (this.readIndex > readIndex) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.quotaReadWaiters.get(readIndex) ?? new Set<() => void>()
      waiters.add(resolve)
      this.quotaReadWaiters.set(readIndex, waiters)
    })
  }

  /** Emits an unexpected child exit. */
  exit(): void {
    this.childEvents.emit('exit', 1, null)
  }

  /**
   * Provides a placeholder event-registration return value.
   *
   * @returns An empty child adapter.
   */
  private get child(): Partial<CodexAppServerChild> {
    return {}
  }

  /**
   * Parses client JSONL frames and writes deterministic responses.
   *
   * @param text Serialized client JSONL fragment.
   */
  private consume(text: string): void {
    this.input += text
    while (true) {
      const newline = this.input.indexOf('\n')
      if (newline < 0) return
      const line = this.input.slice(0, newline)
      this.input = this.input.slice(newline + 1)
      const message = JSON.parse(line) as Record<string, unknown>
      const method = String(message.method)
      this.methods.push(method)
      if (message.id == null) continue
      if (method === 'initialize') {
        if (this.failInitialize) {
          this.respondError(message.id)
          continue
        }
        this.respond(message.id, {
          userAgent: 'fake',
          codexHome: '/tmp/codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        })
      } else if (method === 'account/read') {
        const accountReadIndex = this.accountReadIndex
        this.accountReadIndex += 1
        if (this.failedAccountReads.has(accountReadIndex)) {
          this.respondError(message.id)
          continue
        }
        this.respond(message.id, {
          account: this.account,
          requiresOpenaiAuth: true,
        })
      } else if (method === 'account/rateLimits/read') {
        const readIndex = this.readIndex
        this.readIndex += 1
        for (const resolve of this.quotaReadWaiters.get(readIndex) ?? []) resolve()
        this.quotaReadWaiters.delete(readIndex)
        if (this.failedQuotaReads.has(readIndex)) {
          this.respondError(message.id)
          continue
        }
        if (this.emptyQuota) {
          this.respond(message.id, {
            rateLimits: null,
            rateLimitsByLimitId: null,
            rateLimitResetCredits: null,
          })
          continue
        }
        const usedPercent = this.usageSequence[readIndex % this.usageSequence.length]
        const result = this.quotaResponseOverrides.has(readIndex)
          ? this.quotaResponseOverrides.get(readIndex)
          : fakeQuotaResponse({ fiveHour: usedPercent, sevenDay: 41 })
        const respond = (): void => {
          this.deferredQuotaResponses.delete(readIndex)
          this.respond(message.id, result, this.notificationsAfterQuotaRead.get(readIndex))
        }
        if (this.deferredQuotaReads.has(readIndex)) {
          this.deferredQuotaResponses.set(readIndex, respond)
        } else {
          respond()
        }
      }
    }
  }

  /**
   * Writes one successful response frame.
   *
   * @param id Request identifier echoed by the response.
   * @param result Response payload.
   * @param notifications Optional notifications serialized in the same stream chunk.
   */
  private respond(id: unknown, result: unknown, notifications: readonly unknown[] = []): void {
    const frames = [{ id, result }, ...notifications]
    this.stdout.write(`${frames.map((frame) => JSON.stringify(frame)).join('\n')}\n`)
  }

  /**
   * Writes one protocol error response frame.
   *
   * @param id Request identifier echoed by the response.
   */
  private respondError(id: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, error: { code: -32_000, message: 'temporary' } })}\n`)
  }
}

/**
 * Creates a child that accepts input but never sends a protocol response.
 *
 * @returns A silent in-memory child-process adapter.
 */
function createSilentChild(): CodexAppServerChild {
  const input = new PassThrough()
  const output = new PassThrough()
  const errors = new PassThrough()
  const events = new EventEmitter()
  const child: CodexAppServerChild = {
    stdin: input,
    stdout: output as unknown as CodexAppServerChild['stdout'],
    stderr: errors as unknown as CodexAppServerChild['stderr'],
    on: (event, listener) => {
      events.on(event, listener)
      return child
    },
    kill: () => true,
  }
  return child
}

/**
 * Waits until a test condition succeeds or a small deadline expires.
 *
 * @param condition Condition polled during the wait.
 * @param timeoutMs Maximum wait duration.
 * @returns A promise that settles after success or timeout.
 */
async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/**
 * Keeps the event loop referenced while an operation awaits unref'ed production timers.
 *
 * @param operation Asynchronous test operation that must settle.
 * @param timeoutMs Maximum time allowed for the operation.
 * @returns The operation result.
 * @throws When the operation does not settle before the deadline.
 */
async function withTestDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Test operation did not settle within ${timeoutMs} ms`))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

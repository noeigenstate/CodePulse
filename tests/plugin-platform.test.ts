import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { normalizeAmbient, normalizeShellPreferences, type StatusSnapshot } from '@codepulse/shared'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { PluginCredentialStore, PluginSource } from '../apps/desktop/src/main/plugin-platform.js'
import {
  registerPluginIpc,
  guardPluginNavigation,
  coalescePluginChanges,
} from '../apps/desktop/src/main/plugin-ipc.js'
import { pluginPlatformUrl } from '../apps/desktop/src/plugin-platform-config.js'
import { pluginPlatformCsp } from '../apps/desktop/plugin-platform-csp.js'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import {
  qualifies,
  pauseReason,
  deviceCard,
  withAmbient,
} from '../apps/desktop/src/main/ambient-rules.js'
import { cardCategory } from '../apps/desktop/src/renderer/src/lib/ambientStatus.js'

const baseUrl = 'http://127.0.0.1:18080'
const noon = new Date(2026, 10, 8, 12).getTime()
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
const client = { clientId: 'client-id', token: 'private-client-token' }
const rawCard = (overrides = {}) => ({
  id: 'today',
  pluginId: 'official.poem',
  source: '每日古诗',
  text: '明月松间照',
  expiresAt: noon + 3600000,
  ...overrides,
})
function fixture(
  options: {
    available?: boolean
    stored?: boolean
    timeoutMs?: number
    changed?: () => void
  } = {},
) {
  let now = noon
  let saved: Record<string, unknown> = {}
  let reply: unknown = {
    v: 1,
    generatedAt: noon,
    nextPollAt: noon + 600000,
    cards: [rawCard()],
    errors: {},
  }
  let failure = 0
  let offline = false
  let installs: unknown = []
  const requests: { url: string; init?: RequestInit }[] = []
  const io = {
    available: () => options.available !== false,
    encrypt: (plaintext: string) => Buffer.from('encrypted:' + plaintext),
    decrypt: (ciphertext: Buffer) => ciphertext.toString().replace(/^encrypted:/, ''),
    read: () => saved,
    write: (value: Record<string, unknown>) => {
      saved = value
    },
  }
  const keys = new PluginCredentialStore(baseUrl, io)
  if (options.stored) keys.set(client)
  const source = new PluginSource({
    baseUrl,
    credentials: keys,
    now: () => now,
    changed: options.changed ?? (() => {}),
    timeoutMs: options.timeoutMs,
    fetch: (async (url, init) => {
      requests.push({ url: String(url), init })
      if (offline) throw Error('private upstream detail')
      if (String(url).endsWith('/clients')) return json(client)
      if (String(url).endsWith('/store-code'))
        return json({ code: 'one/time?code', expiresAt: now + 60000 })
      if (String(url).endsWith('/client/installs')) return json({ installs }, failure || 200)
      return json(reply, failure || 200)
    }) as typeof fetch,
  })
  return {
    source,
    keys,
    io,
    requests,
    now: (value: number) => {
      now = value
    },
    feed: (value: unknown) => {
      reply = value
    },
    installs: (value: unknown) => {
      installs = value
    },
    fail: (status: number) => {
      failure = status
    },
    offline: () => {
      offline = true
    },
    saved: () => saved,
  }
}

test('platform URL accepts HTTP only for loopback and literal private IPv4, with root paths only', () => {
  for (const url of [
    baseUrl,
    baseUrl + '/',
    'http://localhost:18080/',
    'http://[::1]:18080/',
    'http://192.168.100.4:18080',
    'http://10.1.2.3',
    'http://172.20.0.1',
    'http://172.16.0.0',
    'http://172.31.255.255',
    'https://platform.example/',
  ])
    assert.equal(pluginPlatformUrl(url), new URL(url).origin)
  for (const url of [
    'file:///tmp/platform',
    'javascript:alert(1)',
    'http://user:secret@example.com',
    baseUrl + '/?token=secret',
    baseUrl + '/#section',
    baseUrl + '///',
    'https://platform.example/store/',
    'http://platform.example/',
    'http://172.15.255.255',
    'http://172.32.0.1',
    'http://192.169.0.1',
    'http://example.com',
    'http://8.8.8.8',
    'http://10.1.2.3.example.com',
    'http://localhost.example/',
  ])
    assert.throws(() => pluginPlatformUrl(url))
})

test('platform URL defaults never read a runtime environment override', () => {
  const previous = process.env.CODEPULSE_PLATFORM_URL
  try {
    process.env.CODEPULSE_PLATFORM_URL = 'https://runtime-override.example'
    assert.equal(pluginPlatformUrl(), baseUrl)
    assert.equal(pluginPlatformUrl('https://built.example/'), 'https://built.example')
  } finally {
    if (previous === undefined) delete process.env.CODEPULSE_PLATFORM_URL
    else process.env.CODEPULSE_PLATFORM_URL = previous
  }
})

test('no registration on construction, start or refresh; opening registers and returns only a store URL', async () => {
  const f = fixture()
  f.source.start()
  await f.source.refresh()
  assert.equal(f.requests.length, 0)
  const result = await f.source.open('dark')
  await f.source.refresh()
  assert.ok('url' in result)
  const url = new URL(result.url)
  assert.equal(url.searchParams.get('code'), 'one/time?code')
  assert.equal(url.searchParams.get('theme'), 'dark')
  assert.deepEqual(Object.keys(result), ['url'])
  assert.equal(JSON.stringify(result).includes(client.token), false)
  assert.equal(JSON.stringify(result).includes(client.clientId), false)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/clients')).length, 1)
  for (const request of f.requests.filter((r) => !r.url.endsWith('/clients'))) {
    assert.deepEqual(request.init?.headers, { Authorization: `Bearer ${client.token}` })
    assert.equal(request.init?.credentials, 'omit')
    assert.equal(request.init?.redirect, 'error')
  }
  await f.source.open('light')
  assert.equal(f.requests.filter((r) => r.url.endsWith('/clients')).length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/store-code')).length, 2)
  f.source.stop()
})

test('concurrent page opens share registration and each request a fresh store code', async () => {
  const f = fixture()
  await Promise.all([f.source.open('light'), f.source.open('dark')])
  await f.source.refresh()
  assert.equal(f.requests.filter((r) => r.url.endsWith('/clients')).length, 1)
  assert.equal(f.requests.filter((r) => r.url.endsWith('/store-code')).length, 2)
})

test('encrypted credentials reload only for their platform and secure storage is required before registering', async () => {
  const f = fixture({ stored: true })
  assert.deepEqual(Object.keys(f.saved()), ['client'])
  assert.equal(JSON.stringify(f.saved()).includes(client.token), false)
  assert.deepEqual(new PluginCredentialStore(baseUrl, f.io).get(), client)
  assert.equal(new PluginCredentialStore('https://other.example', f.io).get(), null)
  const locked = fixture({ available: false })
  assert.deepEqual(await locked.source.open('light'), { error: '系统加密存储不可用，未保存客户端' })
  assert.equal(locked.requests.length, 0)
})

test('feed maps plain, checklist, life and bitmap cards and drops invalid cards or plugin ids', async () => {
  const f = fixture({ stored: true })
  const life = {
    kind: 'poem',
    title: '山居秋暝',
    author: '王维',
    dynasty: '唐',
    lines: ['明月松间照', '清泉石上流'],
  }
  // Use an established production layout so the contract remains the validation authority.
  const { yuanbaoSample } = await import('../apps/desktop/src/main/ambient-yuanbao.js')
  const sample = yuanbaoSample('weather').life!
  f.feed({
    v: 1,
    generatedAt: noon,
    nextPollAt: noon + 60000,
    errors: {},
    cards: [
      rawCard(),
      rawCard({ id: 'list', items: [{ title: '读书', meta: '', overdue: false }] }),
      rawCard({ id: 'life', life: sample }),
      rawCard({
        id: 'image',
        imageHex: '00'.repeat(9984),
        red: { x: 0, y: 0, w: 8, h: 1, hex: '80' },
      }),
      rawCard({ id: 'bad-image', imageHex: 'ff' }),
      rawCard({ expiresAt: noon }),
      rawCard({ id: 'bad-life', life }),
      rawCard({ pluginId: '../escape' }),
      rawCard({ text: 'bad\u0000text' }),
      rawCard({ id: 'two', life: sample, items: [] }),
    ],
  })
  await f.source.refresh()
  const cards = f.source.cards()
  assert.equal(cards.length, 4)
  assert.deepEqual(cards[0], {
    id: 'plugin:official.poem:today',
    kind: 'plugin',
    plugin: { id: 'official.poem' },
    source: '每日古诗',
    text: '明月松间照',
    url: '',
    publishedAt: noon,
    expiresAt: noon + 3600000,
    score: 0,
  })
  assert.equal(cards[1]!.items?.[0]?.title, '读书')
  assert.equal(cards[2]!.layout, 'life')
  assert.deepEqual(cards[2]!.life, sample)
  assert.equal(cards[3]!.red?.hex, '80')
  for (const card of cards) {
    const projected = deviceCard(card)
    assert.equal(projected.source, card.source)
    assert.equal(projected.layout, card.layout)
    assert.deepEqual(projected.life, card.life)
    assert.deepEqual(projected.items, card.items)
    assert.equal(projected.imageHex, card.imageHex)
    assert.deepEqual(projected.red, card.red)
    const status = toDeviceStatusV1(new StatusHub().snapshot())
    assert.ok(withAmbient(status, card).ambient)
  }
})

test('401 clears credentials and cards, next open registers again', async () => {
  const f = fixture({ stored: true })
  await f.source.refresh()
  assert.equal(f.source.cards().length, 1)
  f.fail(401)
  await f.source.refresh()
  assert.equal(f.keys.get(), null)
  assert.deepEqual(f.saved(), {})
  assert.deepEqual(f.source.cards(), [])
  f.fail(0)
  await f.source.open('light')
  await f.source.refresh()
  assert.equal(f.requests.filter((r) => r.url.endsWith('/clients')).length, 1)
})

test('offline keeps previous cards only until their original expiry; malformed feeds do not replace them', async () => {
  const f = fixture({ stored: true })
  await f.source.refresh()
  f.feed({ cards: [] })
  await f.source.refresh()
  assert.equal(f.source.cards().length, 1)
  f.offline()
  await f.source.refresh()
  assert.equal(f.source.cards().length, 1)
  f.now(noon + 3600000)
  assert.deepEqual(f.source.cards(), [])
  assert.deepEqual(await f.source.open('light'), { error: '插件平台未连接' })
})

test('network timeout covers body reads and aborts the injected fetch', async () => {
  const f = fixture({ stored: true })
  let signal: AbortSignal | null | undefined
  const source = new PluginSource({
    baseUrl,
    credentials: f.keys,
    now: () => noon,
    changed: () => {},
    timeoutMs: 10,
    fetch: (async (_url, init) => {
      signal = init?.signal
      return { ok: true, status: 200, json: () => new Promise(() => {}) } as Response
    }) as typeof fetch,
  })
  await source.refresh()
  assert.equal(signal?.aborted, true)
  assert.deepEqual(source.cards(), [])
})

test('polling honours the server schedule within 30 seconds and 15 minutes; stop clears timers', async (t) => {
  const f = fixture({ stored: true })
  const delays: number[] = []
  const set = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, delay?: number) => {
    if ((delay ?? 0) > 10000) delays.push(delay!)
    return set(fn, delay)
  })
  f.source.start()
  await f.source.refresh()
  assert.equal(delays.at(-1), 600000)
  for (const [nextPollAt, expectedDelay] of [
    [noon - 1000, 30000],
    [noon + 30000, 30000],
    [noon + 60000, 60000],
    [noon + 900000, 900000],
    [noon + 7200000, 900000],
  ]) {
    f.feed({ v: 1, generatedAt: noon, nextPollAt, cards: [], errors: {} })
    await f.source.refresh()
    assert.equal(delays.at(-1), expectedDelay)
  }
  f.source.stop()
  const count = f.requests.length
  await f.source.refresh()
  assert.equal(f.requests.length, count)
})

test('a failed pull retries after 60 seconds, then a successful retry restores the normal interval', async (t) => {
  const f = fixture({ stored: true })
  f.feed({ v: 1, generatedAt: noon, nextPollAt: noon + 7200000, cards: [rawCard()], errors: {} })
  let scheduled!: { delay: number; run: () => void; timer: ReturnType<typeof setTimeout> }
  const set = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, delay?: number) => {
    const timer = set(fn, delay)
    if ((delay ?? 0) > 10000) scheduled = { delay: delay!, run: fn, timer }
    return timer
  })
  try {
    f.source.start()
    await f.source.refresh()
    const originalExpiry = f.source.cards()[0]!.expiresAt
    f.fail(429)
    await f.source.refresh()
    assert.equal(scheduled.delay, 60000)
    assert.equal(f.source.cards()[0]!.expiresAt, originalExpiry)

    clearTimeout(scheduled.timer)
    f.now(noon + 60000)
    f.fail(0)
    const previousRequests = f.requests.length
    scheduled.run()
    await f.source.refresh()
    assert.equal(f.requests.length, previousRequests + 1)
    assert.equal(scheduled.delay, 15 * 60000)
  } finally {
    f.source.stop()
  }
})

test('AmbientService includes plugin cards, keeps global rules and exits manual mode after uninstall', async () => {
  const f = fixture({ stored: true })
  await f.source.refresh()
  const status = new StatusHub().snapshot()
  const config = normalizeAmbient({
    enabled: true,
    quietStart: 0,
    quietEnd: 0,
    conceptsEnabled: false,
    petEnabled: false,
    calendarEnabled: false,
  })
  let changes = 0
  const service = new AmbientService({
    plugins: f.source,
    config,
    now: () => noon,
    status: () => status,
    key: () => '',
    save: () => {},
    request: async () => ({}),
    image: async () => '',
    changed: () => {
      changes++
    },
  })
  const card = service.snapshot().cards.find((card) => card.kind === 'plugin')!
  assert.ok(card)
  assert.equal(qualifies(card, config, noon), true)
  assert.equal(cardCategory(card), 'plugin')
  assert.equal(pauseReason({ ...config, enabled: false }, status, noon), '桌边内容已关闭')
  assert.equal(pauseReason({ ...config, quietStart: 11, quietEnd: 13 }, status, noon), '安静时段')
  const busy = { ...status, agents: [{ taskHidden: false, state: 'THINKING' }] } as StatusSnapshot
  assert.equal(pauseReason(config, busy, noon), '等待 Agent 空闲')
  service.showManual(card.id)
  assert.equal(service.current()?.id, card.id)
  f.feed({ v: 1, generatedAt: noon, nextPollAt: noon + 900000, cards: [], errors: {} })
  await f.source.refresh()
  assert.equal(
    service.snapshot().cards.some((c) => c.kind === 'plugin'),
    false,
  )
  assert.equal(service.current(), undefined)
  const previousChanges = changes
  service.dismissTemporary()
  assert.equal(changes, previousChanges)
  service.stop()
})

test('an install change during a pending feed triggers a fresh fetch after that feed', async () => {
  const f = fixture({ stored: true })
  let release!: (response: Response) => void
  let requests = 0
  const feed = (cards: unknown[]) => ({
    v: 1,
    generatedAt: noon,
    nextPollAt: noon + 900000,
    cards,
    errors: {},
  })
  const source = new PluginSource({
    baseUrl,
    credentials: f.keys,
    now: () => noon,
    changed: () => {},
    fetch: (async () => {
      requests++
      if (requests === 1)
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      return json(feed([rawCard()]))
    }) as typeof fetch,
  })
  const first = source.refresh()
  const edited = source.refresh(true)
  release(json(feed([])))
  await Promise.all([first, edited])
  assert.equal(requests, 2)
  assert.equal(source.cards().length, 1)
})

test('stopping a source aborts pending requests and discards late results', async () => {
  const f = fixture({ stored: true })
  let release!: (response: Response) => void
  let signal: AbortSignal | null | undefined
  const source = new PluginSource({
    baseUrl,
    credentials: f.keys,
    now: () => noon,
    changed: () => {},
    fetch: (async (_url, init) => {
      signal = init?.signal
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }) as typeof fetch,
  })
  const pending = source.refresh()
  source.stop()
  assert.equal(signal?.aborted, true)
  release(
    json({ v: 1, generatedAt: noon, nextPollAt: noon + 900000, cards: [rawCard()], errors: {} }),
  )
  await pending
  assert.deepEqual(source.cards(), [])
  assert.deepEqual(f.keys.get(), client)
})

test('IPC returns only safe open results, uses shell theme, and rejects an untrusted sender', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const f = fixture()
  let changed = 0
  const trustedEvent = {} as IpcMainInvokeEvent
  registerPluginIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown)
      },
    } as Pick<IpcMain, 'handle'>,
    {
      trusted: (event) => event === trustedEvent,
      theme: () => 'dark',
      open: (theme, options) => f.source.open(theme, options),
      list: () => f.source.list(),
      setEnabled: (id, enabled) => f.source.setEnabled(id, enabled),
      uninstall: (id) => f.source.uninstall(id),
      logos: {
        list: () => ({}),
        pick: async () => ({ cancelled: true }),
        reset: () => ({ ok: true }),
      },
      refresh: async () => {
        changed++
        await f.source.refresh()
      },
    },
  )
  assert.deepEqual(await handlers.get('plugins:open')!({}), { error: '无权限' })
  assert.equal(f.requests.length, 0)
  for (const channel of [
    'plugins:set-enabled',
    'plugins:uninstall',
    'plugins:pick-logo',
    'plugins:reset-logo',
  ])
    assert.deepEqual(await handlers.get(channel)!({}, 'official.poem', false), { error: '无权限' })
  assert.deepEqual(await handlers.get('plugins:logos')!({}), {})
  assert.deepEqual(await handlers.get('plugins:list')!({}), {
    state: 'offline',
    platformOrigin: '',
    plugins: [],
  })
  assert.equal(handlers.has('plugins:changed'), false)
  assert.equal(f.requests.length, 0)
  const result = await handlers.get('plugins:open')!(trustedEvent)
  assert.match(JSON.stringify(result), /theme=dark/)
  assert.equal(JSON.stringify(result).includes(client.token), false)
  await handlers.get('plugins:refresh')!({})
  assert.equal(changed, 0)
  await handlers.get('plugins:refresh')!(trustedEvent)
  assert.equal(changed, 1)
  const embedded = await handlers.get('plugins:open')!(trustedEvent, {
    embed: true,
    route: '#/developer',
  })
  assert.match(JSON.stringify(embedded), /embed=desktop#\/developer/)
  assert.deepEqual(await handlers.get('plugins:list')!(trustedEvent), {
    state: 'ok',
    platformOrigin: baseUrl,
    plugins: [],
  })
  assert.deepEqual(
    await handlers.get('plugins:set-enabled')!(trustedEvent, 'official.poem', false),
    {
      ok: true,
    },
  )
  assert.deepEqual(await handlers.get('plugins:uninstall')!(trustedEvent, 'official.poem'), {
    ok: true,
  })
  assert.deepEqual(await handlers.get('plugins:pick-logo')!(trustedEvent, 'local:todo'), {
    cancelled: true,
  })
  assert.deepEqual(await handlers.get('plugins:reset-logo')!(trustedEvent, 'local:todo'), {
    ok: true,
  })
})

test('iframe navigation remains on platform; external links and popups go to the browser', () => {
  let popup!: (details: { url: string }) => { action: string }
  let navigate!: (event: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void
  let redirect!: typeof navigate
  let failed!: (
    event: unknown,
    code: number,
    description: string,
    url: string,
    mainFrame: boolean,
  ) => void
  const errors: string[] = []
  const opened: string[] = []
  const contents = {
    setWindowOpenHandler: (handler: typeof popup) => {
      popup = handler
    },
    on: (event: string, handler: typeof navigate) => {
      if (event === 'will-frame-navigate') navigate = handler
      else if (event === 'will-redirect') redirect = handler
      else if (event === 'did-fail-load') failed = handler as unknown as typeof failed
    },
    send: (channel: string) => {
      errors.push(channel)
    },
  } as unknown as WebContents
  guardPluginNavigation(contents, baseUrl, async (url) => {
    opened.push(url)
  })
  let prevented = false
  const event = {
    url: baseUrl + '/developer',
    isMainFrame: false,
    preventDefault: () => {
      prevented = true
    },
  }
  navigate(event)
  assert.equal(prevented, false)
  navigate({ ...event, url: 'https://external.example/' })
  assert.equal(prevented, true)
  assert.deepEqual(popup({ url: 'https://other.example/' }), { action: 'deny' })
  popup({ url: 'javascript:alert(1)' })
  redirect({ ...event, url: 'https://redirect.example/' })
  assert.deepEqual(opened, [
    'https://external.example/',
    'https://other.example/',
    'https://redirect.example/',
  ])
  failed({}, -3, 'aborted', baseUrl, false)
  failed({}, -102, 'connection refused', baseUrl, true)
  failed({}, -102, 'connection refused', baseUrl, false)
  assert.deepEqual(errors, ['plugins:load-error'])
})

test('main-frame navigation and redirects are not blocked or opened externally', () => {
  const handlers: ((event: {
    url: string
    isMainFrame: boolean
    preventDefault: () => void
  }) => void)[] = []
  const contents = {
    setWindowOpenHandler: () => {},
    on: (event: string, handler: (typeof handlers)[number]) => {
      if (event === 'will-frame-navigate' || event === 'will-redirect') handlers.push(handler)
    },
  } as unknown as WebContents
  let prevented = 0
  const opened: string[] = []
  guardPluginNavigation(contents, baseUrl, async (url) => {
    opened.push(url)
  })
  assert.equal(handlers.length, 2)
  for (const handler of handlers) {
    for (const url of ['http://localhost:5173/', 'file:///app/index.html'])
      handler({
        url,
        isMainFrame: true,
        preventDefault: () => {
          prevented++
        },
      })
  }
  assert.equal(prevented, 0)
  assert.deepEqual(opened, [])
})

test('CSP transform uses the same configured image and frame origin, preserving other directives', () => {
  const html = readFileSync('apps/desktop/src/renderer/index.html', 'utf8')
  for (const url of [baseUrl, 'https://store.example:8443/']) {
    const transform = pluginPlatformCsp(url).transformIndexHtml as (html: string) => string
    const result = transform(html)
    assert.equal(
      result,
      html
        .replace('frame-src __PLUGIN_PLATFORM_ORIGIN__', `frame-src ${new URL(url).origin}`)
        .replace("img-src 'self' data:", `img-src 'self' data: ${new URL(url).origin}`),
    )
    assert.match(result, /script-src 'self' 'wasm-unsafe-eval'/)
    assert.match(result, /connect-src 'self' ws:\/\/127\.0\.0\.1:\* http:\/\/127\.0\.0\.1:\*/)
    assert.equal(result.includes('__PLUGIN_PLATFORM_ORIGIN__'), false)
  }
})

test('cloud plugin listing is lazy, distinguishes offline, and preserves installed status', async () => {
  const f = fixture()
  assert.deepEqual(await f.source.list(), {
    state: 'unregistered',
    platformOrigin: baseUrl,
    plugins: [],
  })
  assert.deepEqual(await f.source.setEnabled('official.poem', false), { error: '请先打开插件市场' })
  assert.deepEqual(await f.source.uninstall('official.poem'), { error: '请先打开插件市场' })
  assert.equal(f.requests.length, 0)
  f.keys.set(client)
  const install = {
    pluginId: 'official.poem',
    enabled: false,
    settings: {},
    installedAt: noon,
    status: { generatedAt: null, error: '生成失败' },
    plugin: null,
  }
  f.installs([install])
  assert.deepEqual(await f.source.list(), {
    state: 'ok',
    platformOrigin: baseUrl,
    plugins: [install],
  })
  assert.equal(f.requests.at(-1)?.init?.method, 'GET')
  assert.deepEqual(f.requests.at(-1)?.init?.headers, { Authorization: `Bearer ${client.token}` })
  f.installs([{ ...install, pluginId: '../escape' }])
  assert.deepEqual(await f.source.list(), {
    state: 'offline',
    platformOrigin: baseUrl,
    plugins: [install],
  })
  f.offline()
  assert.deepEqual((await f.source.list()).plugins, [install])
  assert.equal(f.requests.filter((r) => r.url.endsWith('/clients')).length, 0)
})

test('concurrent list callers share one request and offline reads retain locally edited installs', async () => {
  const f = fixture({ stored: true })
  const install = {
    pluginId: 'official.poem',
    enabled: true,
    settings: {},
    installedAt: noon,
    status: { generatedAt: noon, error: '' },
    plugin: null,
  }
  f.installs([install])
  const lists = await Promise.all(Array.from({ length: 5 }, () => f.source.list()))
  assert.equal(f.requests.length, 1)
  lists[0]!.plugins[0]!.enabled = false
  assert.equal(lists[1]!.plugins[0]!.enabled, true)
  assert.deepEqual(await f.source.setEnabled('official.poem', false), { ok: true })
  assert.equal(f.requests.length, 2)
  f.fail(429)
  const offline = await f.source.list()
  assert.equal(offline.state, 'offline')
  assert.deepEqual(offline.plugins, [{ ...install, enabled: false }])
  f.fail(0)
  assert.deepEqual(await f.source.uninstall('official.poem'), { ok: true })
  f.offline()
  assert.deepEqual((await f.source.list()).plugins, [])
})

test('a list started before a toggle cannot overwrite the locally updated cache', async () => {
  const f = fixture({ stored: true })
  const install = {
    pluginId: 'official.poem',
    enabled: true,
    settings: {},
    installedAt: noon,
    status: { generatedAt: noon, error: '' },
    plugin: null,
  }
  let release!: (response: Response) => void
  let lists = 0
  const source = new PluginSource({
    baseUrl,
    credentials: f.keys,
    changed: () => {},
    fetch: (async (_url, init) => {
      if (init?.method === 'PUT') return json({ ok: true })
      if (++lists === 1) return json({ installs: [install] })
      return new Promise<Response>((resolve) => {
        release = resolve
      })
    }) as typeof fetch,
  })
  await source.list()
  const pending = source.list()
  await source.setEnabled('official.poem', false)
  release(json({ installs: [install] }))
  assert.deepEqual((await pending).plugins, [{ ...install, enabled: false }])
})

test('polls notify for content, generation errors and connectivity changes, ignoring polling timestamps', async () => {
  let changes = 0
  const f = fixture({ stored: true, changed: () => changes++ })
  await f.source.refresh()
  assert.equal(changes, 1)
  await f.source.refresh()
  assert.equal(changes, 1)
  const feed = {
    v: 1,
    generatedAt: noon + 1000,
    nextPollAt: noon + 700000,
    cards: [rawCard()],
    errors: {},
  }
  f.feed(feed)
  await f.source.refresh()
  assert.equal(changes, 1)
  f.feed({ ...feed, errors: { 'official.poem': '生成失败' } })
  await f.source.refresh()
  assert.equal(changes, 2)
  f.feed({ ...feed, cards: [rawCard({ text: '清泉石上流' })] })
  await f.source.refresh()
  assert.equal(changes, 3)
  f.fail(503)
  await f.source.refresh()
  assert.equal(changes, 4)
  await f.source.refresh()
  assert.equal(changes, 4)
  f.fail(0)
  await f.source.refresh()
  assert.equal(changes, 5)
})

test('plugin broadcasts merge bursts into at most one event per 300 ms', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let changes = 0
  const changed = coalescePluginChanges(() => changes++)
  changed()
  changed()
  t.mock.timers.tick(299)
  changed()
  assert.equal(changes, 0)
  t.mock.timers.tick(1)
  assert.equal(changes, 1)
  changed()
  changed()
  t.mock.timers.tick(299)
  assert.equal(changes, 1)
  t.mock.timers.tick(1)
  assert.equal(changes, 2)
})

test('reset-logo returns a safe error instead of rejecting when storage fails', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  registerPluginIpc(
    {
      handle: (channel, handler) => {
        handlers.set(channel, handler as (...args: unknown[]) => unknown)
      },
    } as Pick<IpcMain, 'handle'>,
    {
      trusted: () => true,
      theme: () => 'light',
      open: async () => ({ error: 'offline' }),
      refresh: async () => {},
      list: async () => ({ state: 'offline', platformOrigin: baseUrl, plugins: [] }),
      setEnabled: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      logos: {
        list: () => ({}),
        pick: async () => ({ cancelled: true }),
        reset: () => {
          throw Error('/private/userData/file')
        },
      },
    },
  )
  assert.deepEqual(await handlers.get('plugins:reset-logo')!({}, 'local:todo'), {
    error: '图标未能重置',
  })
})

test('listing authorization failure clears credentials without registering again', async () => {
  const f = fixture({ stored: true })
  f.fail(401)
  assert.equal((await f.source.list()).state, 'offline')
  assert.equal((await f.source.list()).state, 'unregistered')
  assert.equal(f.requests.length, 1)
})

test('native toggles and uninstall use client auth without extra pulls, and validate input', async () => {
  const f = fixture({ stored: true })
  for (const id of ['../escape', 'local:todo', 'UPPER', '']) {
    assert.ok('error' in (await f.source.setEnabled(id, true)))
    assert.ok('error' in (await f.source.uninstall(id)))
  }
  assert.ok('error' in (await f.source.setEnabled('official.poem', 'yes' as unknown as boolean)))
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await f.source.setEnabled('official.poem', false), { ok: true })
  const put = f.requests[0]!
  assert.equal(put.url, baseUrl + '/api/v1/client/installs/official.poem')
  assert.equal(put.init?.method, 'PUT')
  assert.deepEqual(JSON.parse(String(put.init?.body)), { enabled: false })
  assert.deepEqual(put.init?.headers, {
    Authorization: `Bearer ${client.token}`,
    'Content-Type': 'application/json',
  })
  assert.equal(f.requests.length, 1)
  assert.deepEqual(await f.source.uninstall('official.poem'), { ok: true })
  assert.equal(f.requests[1]?.init?.method, 'DELETE')
  assert.equal(f.requests.length, 2)
  f.fail(429)
  assert.ok('error' in (await f.source.setEnabled('official.poem', true)))
})

test('disable removes cards and notifies without another pull, discarding an older feed', async () => {
  const f = fixture({ stored: true })
  let release!: (response: Response) => void
  let feedCount = 0
  let changes = 0
  const feed = { v: 1, generatedAt: noon, nextPollAt: noon + 60000, cards: [rawCard()] }
  const source = new PluginSource({
    baseUrl,
    credentials: f.keys,
    now: () => noon,
    changed: () => changes++,
    fetch: (async (_url, init) => {
      if (init?.method === 'PUT') return json({ ok: true })
      feedCount++
      if (feedCount === 1) return json(feed)
      if (feedCount === 2)
        return new Promise<Response>((resolve) => {
          release = resolve
        })
      throw Error('offline')
    }) as typeof fetch,
  })
  await source.refresh()
  assert.equal(source.cards().length, 1)
  const pending = source.refresh()
  assert.deepEqual(await source.setEnabled('official.poem', false), { ok: true })
  assert.deepEqual(source.cards(), [])
  assert.equal(changes, 2)
  release(json(feed))
  await pending
  assert.equal(feedCount, 2)
  assert.deepEqual(source.cards(), [])
})

test('store routes are restricted before registration and valid embed URLs keep the one-time code', async () => {
  const f = fixture()
  for (const route of [
    '#/installed',
    '#/plugin/../escape',
    '#/plugin/official.poem?code=steal',
    '#/plugin/official.poem/extra',
    'https://other.example/',
    '#/developer#other',
    '#/plugin/UPPER',
    '',
  ])
    assert.deepEqual(await f.source.open('dark', { route }), { error: '插件市场地址无效' })
  assert.equal(f.requests.length, 0)
  for (const route of ['#/discover', '#/plugin/official.poem', '#/developer', '#/review']) {
    const result = await f.source.open('light', { route, embed: true })
    assert.ok('url' in result)
    const url = new URL(result.url)
    assert.equal(url.origin, baseUrl)
    assert.equal(url.hash, route)
    assert.equal(url.searchParams.get('embed'), 'desktop')
    assert.equal(url.searchParams.get('code'), 'one/time?code')
  }
})

test('plugins view is additive and saved legacy views still normalize', () => {
  assert.equal(normalizeShellPreferences({ view: 'plugins' }).view, 'plugins')
  assert.equal(normalizeShellPreferences({ view: 'ambient' }).view, 'ambient')
  assert.equal(normalizeShellPreferences({ view: 'screen' }).view, 'window')
  assert.equal(normalizeShellPreferences({ view: 'unknown' }).view, 'window')
})

test('plugins:open prefers the renderer theme over the window theme', async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const opened: string[] = []
  registerPluginIpc(
    {
      handle: (name: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(name, handler),
    } as unknown as Pick<IpcMain, 'handle'>,
    {
      trusted: () => true,
      theme: () => 'dark',
      open: async (theme) => (opened.push(theme), { url: `${baseUrl}/?theme=${theme}` }),
      refresh: async () => {},
      list: async () => ({ state: 'offline', platformOrigin: '', plugins: [] }),
      setEnabled: async () => ({ ok: true }),
      uninstall: async () => ({ ok: true }),
      logos: {
        list: async () => ({}),
        pick: async () => ({ cancelled: true }),
        reset: () => ({ ok: true }),
      },
    } as unknown as Parameters<typeof registerPluginIpc>[1],
  )
  const open = handlers.get('plugins:open')!
  await open({}, { theme: 'light' })
  await open({}, {})
  await open({}, { theme: 'auto' })
  assert.deepEqual(opened, ['light', 'dark', 'dark'])
})

test('only same-origin iframe hash navigation is forwarded for theme reloads', () => {
  let location!: (event: unknown, url: string, mainFrame: boolean) => void
  const messages: unknown[][] = []
  const contents = {
    setWindowOpenHandler: () => {},
    on: (event: string, handler: typeof location) => {
      if (event === 'did-navigate-in-page') location = handler
    },
    send: (...args: unknown[]) => messages.push(args),
  } as unknown as WebContents
  guardPluginNavigation(contents, baseUrl, async () => {})
  const detail = `${baseUrl}/?theme=light&embed=desktop#/plugin/example.test`
  location({}, detail, false)
  location({}, detail, true)
  location({}, 'https://other.example/#/plugin/example.test', false)
  assert.deepEqual(messages, [['plugins:location', detail]])
})

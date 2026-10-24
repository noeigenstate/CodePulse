import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_AMBIENT,
  normalizeAmbient,
  type AmbientCard,
  type StatusSnapshot,
} from '@codepulse/shared'
import { AmbientService, type AmbientHistory } from '../apps/desktop/src/main/ambient-service.js'
import {
  collectX,
  collectMemes,
  xQuery,
  allowedMemeImage,
} from '../apps/desktop/src/main/ambient-sources.js'
import {
  contentKey,
  deviceCard,
  inQuietHours,
  pauseReason,
  qualifies,
  withAmbient,
} from '../apps/desktop/src/main/ambient-rules.js'
import { StatusHub, toDeviceStatusV1 } from '@codepulse/core'
import { checkMemeImage, packMemeBitmap } from '../apps/desktop/src/main/ambient-image.js'
import { registerAmbientIpc } from '../apps/desktop/src/main/ambient-ipc.js'

const noon = new Date(2026, 9, 24, 12).getTime()
const config = normalizeAmbient({ ...DEFAULT_AMBIENT, enabled: true })
const snapshot = (state = 'IDLE', unread = false): StatusSnapshot =>
  ({
    overall: 'idle',
    agents: [
      {
        agentType: 'codex',
        state,
        unread,
        needPermission: false,
        needUserInput: false,
        toolCallCount: 0,
        lastEventAt: 0,
      },
    ],
  }) as StatusSnapshot
const card = (id = 'x:123'): AmbientCard => ({
  id,
  kind: 'x',
  source: '@Polymarket',
  text: 'An important update',
  url: 'https://x.com/Polymarket/status/123',
  publishedAt: noon - 1000,
  expiresAt: noon + 3600000,
  score: 6000,
})
const tweet = (id = '123', overrides = {}) => ({
  id,
  author: { userName: 'Polymarket' },
  text: 'An important update',
  createdAt: new Date(noon - 1000).toISOString(),
  likeCount: 6000,
  isReply: false,
  ...overrides,
})
function fixture(
  options: {
    history?: AmbientHistory
    state?: string
    request?: (url: string) => Promise<unknown>
    image?: (url: string) => Promise<string>
  } = {},
) {
  let now = noon,
    state = options.state ?? 'IDLE',
    changes = 0,
    saved: AmbientHistory | undefined
  const service = new AmbientService({
    config: { ...config, memeEnabled: false },
    history: options.history,
    now: () => now,
    status: () => snapshot(state, state !== 'IDLE'),
    key: () => 'test-key',
    save: (_c, h) => {
      saved = structuredClone(h)
    },
    changed: () => {
      changes++
    },
    request: options.request ?? (async () => ({ tweets: [tweet()] })),
    image: options.image ?? (async () => '00'.repeat(9984)),
  })
  return {
    service,
    advance: (ms: number) => {
      now += ms
    },
    state: (s: string) => {
      state = s
    },
    changes: () => changes,
    saved: () => saved,
  }
}
test('normalization bounds costs and rejects malformed account/query injection', () => {
  const c = normalizeAmbient({
    enabled: true,
    accounts: ['@elonmusk', 'elonmusk OR from:spam', '../admin'],
    pollMinutes: 0,
    gapMinutes: -10,
    dailyLimit: Infinity,
    quietStart: 80,
  })
  assert.deepEqual(c.accounts, ['elonmusk'])
  assert.equal(c.pollMinutes, 15)
  assert.equal(c.gapMinutes, 30)
  assert.equal(c.dailyLimit, 6)
  assert.equal(c.quietStart, 23)
  assert.equal(normalizeAmbient(null).enabled, false)
  assert.match(xQuery(c, noon), /since_time:\d+/)
  assert.doesNotMatch(xQuery(c, noon), /since:/)
})
test('quiet hours handle midnight and disabled intervals', () => {
  assert.equal(inQuietHours(config, new Date(2026, 9, 24, 23).getTime()), true)
  assert.equal(inQuietHours(config, new Date(2026, 9, 24, 7).getTime()), true)
  assert.equal(inQuietHours(config, new Date(2026, 9, 24, 8).getTime()), false)
  assert.equal(inQuietHours({ ...config, quietStart: 8, quietEnd: 8 }, noon), false)
})
test('attention preempts content; read completion allows it; running is optional', () => {
  assert.equal(pauseReason(config, snapshot('WAITING_PERMISSION'), noon), '先处理 Agent 提醒')
  assert.equal(pauseReason(config, snapshot('DONE', true), noon), '先处理 Agent 提醒')
  assert.equal(pauseReason(config, snapshot('DONE', false), noon), '')
  assert.equal(pauseReason(config, snapshot('THINKING'), noon), '等待 Agent 空闲')
  assert.equal(pauseReason({ ...config, idleOnly: false }, snapshot('THINKING'), noon), '')
})
test('threshold, expiry, allowlist, include/exclude apply without a model', () => {
  assert.equal(qualifies(card(), config, noon), true)
  assert.equal(qualifies({ ...card(), score: 4999 }, config, noon), false)
  assert.equal(qualifies({ ...card(), expiresAt: noon }, config, noon), false)
  assert.equal(qualifies({ ...card(), source: '@random' }, config, noon), false)
  assert.equal(qualifies({ ...card(), source: '@elonmusk', score: 20000 }, config, noon), false)
  assert.equal(qualifies({ ...card(), source: '@elonmusk', score: 50000 }, config, noon), true)
  assert.equal(qualifies({ ...card(), text: 'Wow! https://t.co/test' }, config, noon), false)
  assert.equal(qualifies({ ...card(), text: 'giveaway' }, config, noon), false)
  assert.equal(qualifies(card(), { ...config, keywords: ['launch'] }, noon), false)
  assert.notEqual(
    contentKey({ ...card(), text: '今天发布新模型' }),
    contentKey({ ...card(), text: '明天发射火箭' }),
  )
})
test('X providers request one bounded page, preserve attribution, reject replies and sensitive posts', async () => {
  let url = '',
    header: Record<string, string> | undefined
  const request = async (u: string, h?: Record<string, string>) => {
    url = u
    header = h
    return {
      tweets: [
        tweet(),
        tweet('124', { isReply: true }),
        tweet('125', { possibly_sensitive: true }),
        tweet('126', { createdAt: 'bad' }),
      ],
    }
  }
  const cards = await collectX(config, 'secret', noon, request)
  assert.equal(cards.length, 1)
  assert.equal(cards[0]!.source, '@Polymarket')
  assert.equal(header?.['X-API-Key'], 'secret')
  assert.match(url, /queryType=Top/)
  const official = await collectX({ ...config, provider: 'x' }, 'bearer', noon, async (u, h) => {
    assert.match(u, /api.x.com\/2\/tweets\/search\/recent/)
    assert.equal(h?.Authorization, 'Bearer bearer')
    assert.equal(
      new URL(u).searchParams.get('post.fields'),
      'created_at,public_metrics,possibly_sensitive',
    )
    return {
      errors: [],
      data: [
        {
          id: '123',
          author_id: '7',
          text: 'Launch',
          created_at: new Date(noon).toISOString(),
          public_metrics: { like_count: 6000 },
        },
      ],
      includes: { users: [{ id: '7', username: 'OpenAI' }] },
    }
  })
  assert.equal(official[0]!.url, 'https://x.com/OpenAI/status/123')
  await assert.rejects(
    collectX({ ...config, provider: 'x' }, 'key', noon, async () => ({
      errors: [{ title: 'Unauthorized' }],
      meta: {},
    })),
  )
  assert.deepEqual(
    await collectX({ ...config, provider: 'x' }, 'key', noon, async () => ({
      errors: [],
      meta: { result_count: 0 },
    })),
    [],
  )
  await assert.rejects(collectX(config, 'key', noon, async () => ({ error: 'bad' })))
})
test('meme source rejects unsafe image hosts, animation, NSFW and arbitrary links', async () => {
  const m = {
    postLink: 'https://redd.it/abc12',
    subreddit: 'memes',
    title: 'A meme',
    url: 'https://i.redd.it/a.png',
    nsfw: false,
    spoiler: false,
    ups: 3000,
  }
  const cards = await collectMemes(config, noon, async () => ({
    memes: [
      m,
      { ...m, nsfw: true },
      { ...m, url: 'http://127.0.0.1/image' },
      { ...m, url: 'https://i.redd.it/a.gif' },
      { ...m, postLink: 'https://evil.test/' },
    ],
  }))
  assert.equal(cards.length, 1)
  assert.equal(allowedMemeImage('https://i.redd.it.evil.test/a.png'), false)
  assert.equal(allowedMemeImage('https://user@i.redd.it/a.png'), false)
})
test('refresh displays once, persists dedupe, expires, never mutates canonical status', async () => {
  const f = fixture()
  await f.service.refresh()
  assert.equal(f.service.snapshot().shownToday, 1)
  assert.equal(f.service.current()?.id, 'x:123')
  assert.ok(f.saved()?.seen['x:123'])
  assert.ok(f.changes() > 0)
  f.advance(11 * 60000)
  f.service.tick()
  assert.equal(f.service.current(), undefined)
  f.advance(90 * 60000)
  await f.service.refresh()
  assert.equal(f.service.snapshot().shownToday, 1)
  const restarted = fixture({ history: f.saved() })
  await restarted.service.refresh()
  assert.equal(restarted.service.current(), undefined)
})
test('urgent status immediately hides and then discards an active card', async () => {
  const f = fixture()
  await f.service.refresh()
  f.state('WAITING_PERMISSION')
  assert.equal(f.service.current(), undefined)
  f.service.tick()
  f.state('IDLE')
  assert.equal(f.service.current(), undefined)
})
test('manual show cannot bypass disabled mode, active work, frequency or daily cap', async () => {
  const f = fixture({ state: 'THINKING' })
  await f.service.refresh()
  assert.equal(f.service.snapshot().shownToday, 0)
  f.service.show('x:123')
  assert.equal(f.service.current(), undefined)
  f.state('IDLE')
  f.service.show('x:123')
  assert.equal(f.service.snapshot().shownToday, 1)
  f.service.dismiss()
  f.service.show('x:123')
  assert.equal(f.service.current(), undefined)
  f.service.configure({ ...config, enabled: false })
  assert.equal(f.service.current(), undefined)
  const capped = fixture({ history: { day: '2026-10-24', shown: 6, lastShown: 0, seen: {} } })
  await capped.service.refresh()
  assert.equal(capped.service.current(), undefined)
})
test('in-flight old configuration cannot reappear after disable', async () => {
  let resolve!: (v: unknown) => void
  const f = fixture({
    request: () =>
      new Promise((r) => {
        resolve = r
      }),
  })
  const work = f.service.refresh()
  f.service.configure({ ...config, enabled: false })
  resolve({ tweets: [tweet()] })
  await work
  assert.equal(f.service.snapshot().cards.length, 0)
  assert.equal(f.service.current(), undefined)
  assert.equal(f.service.snapshot().collecting, false)
})
test('failed sources degrade quietly and image failure never produces a blank meme', async () => {
  const f = fixture({
    request: async () => {
      throw new Error('private secret must not reach UI')
    },
  })
  await f.service.refresh()
  assert.equal(f.service.snapshot().sourceStatus.x, '连接失败，稍后自动重试')
  assert.equal(f.service.current(), undefined)
})
test('device extension is bounded, revision-aware and does not rewrite the hub', () => {
  const hub = new StatusHub(),
    before = hub.snapshot(),
    status = toDeviceStatusV1(before)
  const result = withAmbient(status, { ...card(), text: '汉'.repeat(500) })
  assert.ok(result.ambient)
  assert.ok(Buffer.byteLength(result.ambient.text) <= 767)
  assert.notEqual(result.revision, status.revision)
  assert.deepEqual(hub.snapshot().agents, before.agents)
  assert.equal(hub.snapshot().overall, before.overall)
  assert.equal(status.ambient, undefined)
  assert.equal(withAmbient(status, undefined), status)
  assert.equal(deviceCard(card()).id.length, 24)
})
test('paid request budget survives restart and also limits manual refresh', async () => {
  let calls = 0
  const f = fixture({
    request: async () => {
      calls++
      return { tweets: [] }
    },
  })
  f.service.configure({ ...config, memeEnabled: false, dailyRequestLimit: 1 })
  await f.service.refresh()
  f.advance(61000)
  await f.service.refresh()
  assert.equal(calls, 1)
  assert.equal(f.service.snapshot().xRequestsToday, 1)
  const restarted = fixture({
    history: f.saved(),
    request: async () => {
      calls++
      return { tweets: [] }
    },
  })
  restarted.service.configure({ ...config, memeEnabled: false, dailyRequestLimit: 1 })
  await restarted.service.refresh()
  assert.equal(calls, 1)
  restarted.advance(86400000)
  await restarted.service.refresh()
  assert.equal(calls, 2)
})
test('disabled service and missing keys make no paid requests', async () => {
  let calls = 0
  const s = new AmbientService({
    config,
    status: () => snapshot(),
    now: () => noon,
    key: () => '',
    save: () => {},
    changed: () => {},
    image: async () => '',
    request: async (url) => {
      if (url.includes('twitter')) calls++
      return { memes: [] }
    },
  })
  await s.refresh()
  assert.equal(calls, 0)
  assert.equal(s.snapshot().sourceStatus.x, '待配置 API 密钥')
  s.configure({ enabled: false })
  await s.refresh()
  assert.equal(calls, 0)
})
test('failed meme image is removed while healthy X candidates remain available', async () => {
  const f = fixture({
    request: async (url) =>
      url.includes('meme-api')
        ? {
            memes: [
              {
                postLink: 'https://redd.it/abc12',
                subreddit: 'memes',
                title: 'Meme',
                url: 'https://i.redd.it/a.png',
                nsfw: false,
                spoiler: false,
                ups: 3000,
              },
            ],
          }
        : { tweets: [tweet()] },
    image: async () => {
      throw new Error('bad image')
    },
  })
  f.service.configure(config)
  await f.service.refresh()
  assert.equal(f.service.snapshot().cards.length, 1)
  assert.equal(f.service.snapshot().cards[0]!.kind, 'x')
  assert.equal(f.service.snapshot().sourceStatus.meme, '图片读取失败，稍后重试')
})
test('encoded image limits reject huge or malformed images before native decoding', () => {
  const png = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12)
  png.writeUInt32BE(400, 16)
  png.writeUInt32BE(300, 20)
  assert.doesNotThrow(() => checkMemeImage(png))
  png.writeUInt32BE(100000, 16)
  assert.throws(() => checkMemeImage(png))
  assert.throws(() => checkMemeImage(Buffer.from('not an image')))
})
test('ink bitmap is bounded, centered, and composites transparency onto white', () => {
  assert.equal(packMemeBitmap(Buffer.from([0, 0, 0, 0]), 1, 1), '00'.repeat(9984))
  const black = Buffer.from(packMemeBitmap(Buffer.from([0, 0, 0, 255]), 1, 1), 'hex')
  assert.equal(black.length, 9984)
  assert.equal(black.filter((n) => n !== 0).length, 1)
  assert.throws(() => packMemeBitmap(new Uint8Array(4), 385, 1))
})
test('optional bitmap never makes the device HTTP response exceed its reader budget', () => {
  const base = toDeviceStatusV1(new StatusHub().snapshot())
  const image = { ...card(), imageHex: '00'.repeat(9984) }
  assert.ok(withAmbient(base, image).ambient)
  const crowded = { ...base, message: 'x'.repeat(22000) }
  assert.equal(withAmbient(crowded, image), crowded)
})
test('production IPC previews are local and original-post links cannot be replaced by renderer URLs', async () => {
  const f = fixture()
  await f.service.refresh()
  const handlers = new Map<string, (...args: any[]) => any>()
  const base = toDeviceStatusV1(snapshot('WAITING_PERMISSION'))
  const before = structuredClone(base),
    opened: string[] = []
  registerAmbientIpc(
    {
      handle: (name, listener) => {
        handlers.set(name, listener)
      },
    },
    { service: f.service, setKey: () => f.service.snapshot() },
    () => base,
    async (url) => {
      opened.push(url)
    },
  )
  const preview = handlers.get('codepulse:ambient-preview')!(undefined, 'x:123')
  assert.equal(preview.ambient.text, card().text)
  assert.equal(preview.agents[0].state, 'idle')
  assert.deepEqual(base, before)
  assert.equal(JSON.stringify(handlers.get('codepulse:ambient-get')!()).includes('test-key'), false)
  await assert.rejects(handlers.get('codepulse:ambient-open')!(undefined, 'https://evil.test/'))
  await handlers.get('codepulse:ambient-open')!(undefined, 'x:123')
  assert.deepEqual(opened, [card().url])
})

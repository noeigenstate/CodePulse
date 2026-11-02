import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { normalizeAmbient, type YuanbaoConfig } from '@codepulse/shared'
import { StatusHub } from '@codepulse/core'
import { AmbientService } from '../apps/desktop/src/main/ambient-service.js'
import { YuanbaoSource } from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import {
  parsePassage,
  webText,
  yuanbaoPages,
  YuanbaoClient,
  type YuanbaoCredentials,
  type YuanbaoSearchParams,
} from '../apps/desktop/src/main/ambient-yuanbao.js'

const now = Date.parse('2026-10-30T07:33:41Z')
const weather = JSON.parse(
  readFileSync('tests/fixtures/yuanbao/yuanbao-weather-m1.json', 'utf8'),
).response
const credentials = { apiKey: 'obviously-fake-review-api-key' }
function setup(
  extra: {
    config?: Partial<YuanbaoConfig>
    key?: YuanbaoCredentials | null
    saveLastResponse?: (raw: unknown) => void
  } = {},
) {
  let clock = now,
    key: YuanbaoCredentials | null = extra.key === undefined ? credentials : extra.key
  let config = normalizeAmbient({
    enabled: true,
    quietStart: 0,
    quietEnd: 0,
    yuanbao: { enabled: true, weatherEnabled: true, ...extra.config },
  })
  const queries: YuanbaoSearchParams[] = []
  let failure = ''
  const source = new YuanbaoSource({
    config: () => config,
    credentials: () => key,
    now: () => clock,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    saveLastResponse: extra.saveLastResponse,
    client: {
      search: async (params) => {
        queries.push(params)
        if (failure) throw Error(failure)
        const raw =
          params.Mode === 1
            ? weather
            : {
                Response: {
                  Pages: [
                    JSON.stringify({
                      title: `${params.Query} v2.4 更新`,
                      passage: 'release',
                      date: '2026-10-30',
                      site: '发布站',
                      url: 'https://example.com/release',
                    }),
                  ],
                },
              }
        return { raw, pages: yuanbaoPages(raw), latencyMs: 12, edition: 'standard' }
      },
    },
  })
  return {
    source,
    queries,
    config: () => config,
    configure: (value: Partial<YuanbaoConfig>) => {
      config = normalizeAmbient({ ...config, yuanbao: { ...config.yuanbao, ...value } })
    },
    setKey: (value: YuanbaoCredentials | null) => {
      key = value
      source.credentialsChanged()
    },
    setTime: (value: number) => {
      clock = value
    },
    fail: (value: string) => {
      failure = value
    },
  }
}

test('review 1: TC3 signs Host without setting a forbidden transport header', async () => {
  let headers = new Headers()
  const client = new YuanbaoClient({
    now: () => now,
    transport: async (_url, init) => {
      headers = new Headers(init.headers)
      return new Response(JSON.stringify(weather))
    },
  })
  await client.search(
    { Query: '北京今天天气', Mode: 1 },
    { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-review-secret' },
  )
  assert.equal(headers.has('host'), false)
  assert.match(headers.get('authorization')!, /SignedHeaders=content-type;host;x-tc-action/)
  assert.equal(headers.get('x-tc-action'), 'SearchPro')
})

for (const [name, enabled, shown] of [
  ['playlist off', false, 0],
  ['display cap reached', true, 1],
] as const) {
  test(`review 2: scheduled Yuanbao is blocked with ${name}, but connection tests remain available`, async () => {
    let calls = 0
    const date = new Date(now),
      localDay = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
    const service = new AmbientService({
      now: () => now,
      config: normalizeAmbient({
        enabled,
        dailyLimit: 1,
        quietStart: 0,
        quietEnd: 0,
        xEnabled: false,
        memeEnabled: false,
        newsEnabled: false,
        calendarEnabled: false,
        yuanbao: { enabled: true, weatherEnabled: true },
      }),
      history: { day: localDay, shown, seen: {}, lastShown: 0 },
      status: () => new StatusHub().snapshot(),
      key: () => '',
      request: async () => ({}),
      image: async () => '',
      save() {},
      changed() {},
      yuanbaoKey: () => credentials,
      yuanbaoClient: {
        search: async () => {
          calls++
          return { raw: weather, pages: yuanbaoPages(weather), latencyMs: 0, edition: 'standard' }
        },
      },
    })
    service.tick()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await service.yuanbao.tick()
    assert.equal(calls, 0)
    assert.equal((await service.yuanbao.test()).ok, true)
    assert.equal(calls, 1)
    service.stop()
  })
}
test('review 2: a previous day display cap resets before scheduled collection', async () => {
  let calls = 0
  const service = new AmbientService({
    now: () => now,
    config: normalizeAmbient({
      enabled: true,
      dailyLimit: 1,
      quietStart: 0,
      quietEnd: 0,
      xEnabled: false,
      memeEnabled: false,
      newsEnabled: false,
      calendarEnabled: false,
      yuanbao: { enabled: true, weatherEnabled: true },
    }),
    history: { day: '2026-10-29', shown: 1, seen: {}, lastShown: 0 },
    status: () => new StatusHub().snapshot(),
    key: () => '',
    request: async () => ({}),
    image: async () => '',
    save() {},
    changed() {},
    yuanbaoKey: () => credentials,
    yuanbaoClient: {
      search: async () => {
        calls++
        return { raw: weather, pages: yuanbaoPages(weather), latencyMs: 0, edition: 'standard' }
      },
    },
  })
  await service.yuanbao.tick()
  assert.equal(calls, 1)
  service.stop()
})

test('review 3: parsing 200k ellipses plus a trailing letter takes under 50 ms', async (t) => {
  // A worker keeps the pre-fix quadratic case from freezing the test runner for a minute.
  const worker = new Worker(
    `const {parentPort,workerData}=require('node:worker_threads');
    const parse=eval('('+workerData+')');
    const value='…'.repeat(200000)+'X';
    const passage='# text：'+value+'\\n# truncated：…';
    parentPort.postMessage('ready');
    parentPort.once('message',()=>{const start=performance.now();const result=parse(passage);
      parentPort.postMessage({elapsed:performance.now()-start,length:result.top.text.length,truncated:result.top.truncated});});`,
    { eval: true, workerData: parsePassage.toString() },
  )
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await new Promise<{ elapsed: number; length: number; truncated?: string }>(
      (resolve, reject) => {
        worker.on('error', reject)
        worker.on('message', (value) => {
          if (value === 'ready') {
            timer = setTimeout(
              () => reject(Error('200k parse exceeded 1000 ms; required under 50 ms')),
              1000,
            )
            worker.postMessage('start')
          } else resolve(value)
        })
      },
    )
    assert.equal(result.length, 200001)
    assert.equal(result.truncated, undefined)
    assert.ok(result.elapsed < 50, `200k parse: ${result.elapsed.toFixed(3)} ms`)
    t.diagnostic(`200k parse: ${result.elapsed.toFixed(3)} ms`)
  } finally {
    clearTimeout(timer)
    await worker.terminate()
  }
})

test('review 4: web entities decode once before stripping encoded HTML tags', () => {
  assert.equal(webText('&lt;b&gt;版本&amp;lt;i&amp;gt;&lt;/b&gt;'), '版本&lt;i&gt;')
  assert.equal(webText('<b>标题</b> &amp; &quot;正文&quot;'), '标题 & "正文"')
  const [page] = yuanbaoPages({
    Response: { Pages: [JSON.stringify({ title: '&lt;b&gt;标题&lt;/b&gt;', passage: '内容' })] },
  })
  assert.equal(page!.title, '标题')
})

test('review 5: saving the same key retains cadence and metadata', async () => {
  const f = setup({ config: { toolsEnabled: true, newsEnabled: true } })
  await f.source.tick()
  const before = f.source.snapshot(),
    count = f.queries.length
  f.setKey({ ...credentials })
  await f.source.tick()
  assert.equal(f.queries.length, count)
  assert.deepEqual(f.source.snapshot(), before)
})
test('review 5: saving the same key does not discard an in-flight paid response', async () => {
  let release: () => void = () => {},
    started: () => void = () => {}
  const pause = new Promise<void>((resolve) => {
    release = resolve
  })
  const sent = new Promise<void>((resolve) => {
    started = resolve
  })
  const source = new YuanbaoSource({
    config: () => normalizeAmbient(undefined),
    credentials: () => ({ ...credentials }),
    holidays: () => ({}),
    hasYear: () => false,
    now: () => now,
    save() {},
    changed() {},
    client: {
      search: async () => {
        started()
        await pause
        return { raw: weather, pages: yuanbaoPages(weather), latencyMs: 12, edition: 'standard' }
      },
    },
  })
  const pending = source.test()
  await sent
  source.credentialsChanged()
  release()
  assert.equal((await pending).ok, true)
  assert.equal(source.cards().length, 1)
  assert.equal(source.snapshot().requestsToday, 1)
})
test('review 5: a key change never refires checked jobs; never-checked jobs run once after inputs settle', async () => {
  const f = setup({ key: null, config: { toolsEnabled: true, newsEnabled: true } })
  f.setKey(credentials)
  await f.source.tick()
  assert.equal(f.queries.length, 0, 'the first tick only registers jobs and waits for inputs to settle')
  f.setTime(now + 2500)
  await f.source.tick()
  const first = f.queries.length
  assert.equal(first, 4, 'weather, both tools and news each run once')
  f.setKey({ apiKey: 'another-obviously-fake-review-key' })
  f.setTime(now + 5000)
  await f.source.tick()
  assert.equal(f.queries.length, first, 'a new key does not spend another round')
  assert.equal((await f.source.test()).ok, true)
  assert.equal(f.queries.length, first + 1, 'a manual connection test still validates immediately')
})
test('review 5: city, tool and topic edits inherit cadence instead of firing for every partial input', async () => {
  const f = setup({ config: { toolsEnabled: true, newsEnabled: true } })
  await f.source.tick()
  const count = f.queries.length
  assert.equal(count, 4, 'initial batch includes both configured tools')
  f.configure({ city: '上', tools: ['New'], newsTopic: '科' })
  await f.source.tick()
  f.configure({ city: '上海', tools: ['New Tool'], newsTopic: '科技新闻' })
  f.setTime(now + 15000)
  await f.source.tick()
  assert.equal(f.queries.length, count)
  f.setTime(now + 7200000)
  await f.source.tick()
  assert.equal(f.queries.length, count + 1)
  assert.match(f.queries.at(-1)!.Query, /上海/)
})
test('review 5: a first paid query also waits for newly edited text to settle', async () => {
  const f = setup()
  f.configure({ city: '上' })
  await f.source.tick()
  assert.equal(f.queries.length, 0)
  f.setTime(now + 1000)
  f.configure({ city: '上海' })
  await f.source.tick()
  f.setTime(now + 2999)
  await f.source.tick()
  assert.equal(f.queries.length, 0)
  f.setTime(now + 3000)
  await f.source.tick()
  assert.equal(f.queries.length, 1)
  assert.match(f.queries[0]!.Query, /上海/)
})

test('review 6: optional last-response write failure preserves a successful result and parsed card', async () => {
  const f = setup({
    saveLastResponse: () => {
      throw Error('EPERM private path')
    },
  })
  const result = await f.source.test()
  assert.equal(result.ok, true)
  assert.match(result.cardText, /今天 晴 4–22℃/)
  assert.equal(f.source.cards().length, 1)
  assert.equal(f.source.snapshot().requestsToday, 1)
  assert.equal(f.source.snapshot().lastError, '')
})
for (const [status, expected] of [
  [401, '密钥错误'],
  [403, '密钥错误'],
  [429, '限流，稍后再试'],
] as const) {
  test(`review 7: non-JSON HTTP ${status} maps to the fixed gateway error`, async () => {
    const client = new YuanbaoClient({
      transport: async () => new Response('<html>private gateway details</html>', { status }),
    })
    await assert.rejects(client.search({ Query: 'test', Mode: 1 }, credentials), {
      message: expected,
    })
  })
}

test('review 8: scheduled topic errors remain isolated from other topics and manual/global errors', async () => {
  const f = setup({ config: { toolsEnabled: true, tools: ['Codex'] } })
  f.fail('密钥错误')
  await f.source.tick()
  assert.deepEqual(Reflect.get(f.source.snapshot(), 'errors'), {
    weather: '密钥错误',
    tools: '密钥错误',
  })
  assert.equal(f.source.snapshot().lastError, '')
  f.fail('')
  f.configure({ weatherEnabled: false })
  f.setTime(now + 43200000)
  await f.source.tick()
  assert.deepEqual(Reflect.get(f.source.snapshot(), 'errors'), { weather: '密钥错误' })
  f.fail('连接失败')
  assert.equal((await f.source.test()).ok, false)
  assert.equal(f.source.snapshot().lastError, '连接失败')
  assert.deepEqual(Reflect.get(f.source.snapshot(), 'errors'), { weather: '密钥错误' })
  f.fail('')
  f.setTime(now + 86400000)
  await f.source.tick()
  assert.equal(
    f.source.snapshot().lastError,
    '连接失败',
    'unrelated scheduled success must not clear a manual/global error',
  )
  await f.source.test()
  assert.equal(f.source.snapshot().lastError, '')
  assert.deepEqual(Reflect.get(f.source.snapshot(), 'errors'), {})
})
test('review 8: success for one tool does not erase another tool failure in the same topic', async () => {
  const source = new YuanbaoSource({
    config: () =>
      normalizeAmbient({
        enabled: true,
        quietStart: 0,
        quietEnd: 0,
        yuanbao: { enabled: true, toolsEnabled: true, tools: ['Broken', 'Working'] },
      }),
    credentials: () => credentials,
    holidays: () => ({}),
    hasYear: () => false,
    now: () => now,
    save() {},
    changed() {},
    client: {
      search: async (params) => {
        if (params.Query.startsWith('Broken')) throw Error('密钥错误')
        const raw = {
          Response: {
            Pages: [
              JSON.stringify({
                title: 'Working v2.4 release',
                passage: 'release',
                site: '发布站',
                url: 'https://example.com/working',
                date: '2026-10-30',
              }),
            ],
          },
        }
        return { raw, pages: yuanbaoPages(raw), latencyMs: 12, edition: 'standard' }
      },
    },
  })
  await source.tick()
  assert.deepEqual(Reflect.get(source.snapshot(), 'errors'), { tools: '密钥错误' })
  assert.equal(source.snapshot().lastError, '')
  assert.equal(source.cards().length, 1)
})

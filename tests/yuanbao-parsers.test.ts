import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { DEFAULT_YUANBAO, normalizeYuanbao } from '@codepulse/shared'
import {
  parsePassage,
  yuanbaoPages,
  weatherCard,
  goldCard,
  stockCard,
  toolCard,
  holidayCard,
  newsCard,
  yuanbaoSample,
  signedYuanbaoHeaders,
  YuanbaoClient,
  YUANBAO_TIMEOUT_MS,
  YUANBAO_MAX_BYTES,
  yuanbaoResponseJson,
} from '../apps/desktop/src/main/ambient-yuanbao.js'

const now = Date.parse('2026-10-30T07:33:41Z')
const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/yuanbao/yuanbao-${name}.json`, 'utf8'))

test('Yuanbao normalization starts every paid feature off and retains validated presets', () => {
  const defaults = normalizeYuanbao(undefined)
  assert.deepEqual(defaults, DEFAULT_YUANBAO)
  for (const field of [
    'enabled',
    'weatherEnabled',
    'goldEnabled',
    'stocksEnabled',
    'toolsEnabled',
    'holidayEnabled',
    'newsEnabled',
  ] as const)
    assert.equal(defaults[field], false)
  assert.equal(defaults.goldBrand, true)
  const config = normalizeYuanbao({
    stocks: ['00700.HK', '../secret', '00700.hk', '600519.sh', 'aapl.us', '000001.sz'],
    tools: ['Codex', 'Codex', 'Claude Code'],
    dailyRequestLimit: 500,
  })
  assert.deepEqual(config.stocks, ['00700.hk', '600519.sh', 'aapl.us'])
  assert.deepEqual(config.tools, ['Codex', 'Claude Code'])
  assert.equal(config.dailyRequestLimit, 200)
  assert.equal(normalizeYuanbao({ dailyRequestLimit: 0 }).dailyRequestLimit, 1)
})

test('TC3 signer matches the independently computed reference vector with UTF-8 payload bytes', () => {
  // Fictitious credentials only. Expected signature was computed independently from the reference algorithm.
  const headers = signedYuanbaoHeaders(
    JSON.stringify({ Query: '北京今天天气', Mode: 1 }),
    { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-unit-secret' },
    1793344500,
  )
  assert.equal(
    headers.Authorization,
    'TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2026-10-30/wsa/tc3_request, SignedHeaders=content-type;host;x-tc-action, Signature=fafe84633f7473a4d1739d771049887e8e47a2e9a2617da1dc9230797e80397b',
  )
  assert.equal(headers['X-TC-Version'], '2025-05-08')
  assert.equal(headers['X-TC-Action'], 'SearchPro')
  assert.equal(headers.Host, 'wsa.tencentcloudapi.com')
  assert.equal(headers['X-TC-Region'], undefined)
  const next = signedYuanbaoHeaders(
    '{}',
    { secretId: 'AKIDEXAMPLE', secretKey: 'obviously-fake-unit-secret' },
    Date.parse('2026-10-30T23:59:59Z') / 1000,
  )
  assert.ok(next.Authorization!.includes('/2026-10-30/wsa/'))
})

test('parsePassage separates top fields and blank-line blocks, discarding only truncated fields', () => {
  const parsed = parsePassage(
    '# 城市：北京\n\n日期：2026-10-30\n温度：22\n\n日期：2026-10-31\n天气：多云...',
  )
  assert.deepEqual(parsed, {
    top: { 城市: '北京' },
    blocks: [{ 日期: '2026-10-30', 温度: '22' }, { 日期: '2026-10-31' }],
  })
  assert.deepEqual(parsePassage('# __proto__：pollution\n未知文字\n...'), { top: {}, blocks: [] })
})

for (const name of ['weather-m1', 'weather-m2']) {
  test(`${name} selects 气象在线 and today's block rather than yesterday or conflicting web results`, () => {
    const card = weatherCard(yuanbaoPages(fixture(name)), '北京', now)!
    assert.equal(card.source, '元宝搜索 · 气象在线')
    assert.match(card.text, /今天 晴 4–22℃/)
    assert.match(card.text, /体感15℃/)
    assert.match(card.text, /西北风3级/)
    assert.match(card.text, /湿度32%/)
    assert.match(card.text, /空气60/)
    assert.match(card.text, /限行4和9/)
    assert.match(card.text, /日落17:15/)
    assert.match(card.text, /明天 — 6–12℃/)
    assert.doesNotMatch(card.text, /18–9|阵雨|19–5/)
    assert.equal(card.expiresAt - now, 3 * 3600000)
    assert.ok(Array.from(card.text).length <= 120)
  })
}
test('weather parser supports the international wind field and rejects dates it cannot locate', () => {
  const pages = yuanbaoPages(fixture('weather-m1')).slice(0, 1)
  assert.match(weatherCard(pages, '北京', now)!.text, /东风2级/)
  assert.equal(weatherCard(pages, '北京', Date.parse('2027-01-01T00:00:00Z')), undefined)
})
test('gold fixture selects domestic spot, international price and optional first brand', () => {
  const pages = yuanbaoPages(fixture('gold-m1')),
    card = goldCard(pages, true, now)!
  assert.match(card.text, /国内现货金 852.80 元\/克 ↓0.90%（-7.77）/)
  assert.match(card.text, /国际 3984.98 美元\/盎司/)
  assert.match(card.text, /周大福 1199元\/克/)
  assert.doesNotMatch(card.text, /周六福|昨收|861.66/)
  assert.doesNotMatch(goldCard(pages, false, now)!.text, /周大福/)
  assert.equal(card.publishedAt, 1793345461000)
  assert.equal(card.expiresAt - now, 3600000)
})
test('stock fixture isolates the HK segment from TCTZF and drops the truncated final field', () => {
  const pages = yuanbaoPages(fixture('stock-m1')),
    card = stockCard(pages, '00700.hk', now)
  assert.match(card.text, /腾讯控股 00700.HK 384.200 ↑1.75%（6.600）交易中/)
  assert.match(card.text, /高 387.600 低 375.200 · 15:29/)
  assert.doesNotMatch(card.text, /49.35|34933/)
  const hk = parsePassage(pages[0]!.passage.split('\n\n\n')[1]!)
  assert.equal(hk.top['总市值'], undefined)
  assert.match(stockCard(pages, 'tctzf.us', now).text, /TCTZF.US 49.35 ↓3.19%/)
  assert.match(stockCard(pages, 'tctzf.us', now).text, /10\/29 15:53/)
  assert.equal(
    stockCard(pages, 'tctzf.us', now).expiresAt,
    now + 3600000,
    'last quotes retain the source date but expire one hour after observation',
  )
  const absent = stockCard(pages, 'aapl.us', now)
  assert.equal(absent.text, '未找到 AAPL.US 的行情')
  assert.equal(absent.score, 0)
  const truncated = stockCard(
    [
      {
        ...pages[0]!,
        passage: '# 股票：腾讯\n# 股票代码：00700\n# 股票代码前缀：hk\n# 实时股价：384...',
      },
    ],
    '00700.hk',
    now,
  )
  assert.match(truncated.text, /00700.HK —/)
  assert.equal(truncated.score, 0)
})
test('malformed page strings are skipped without discarding valid pages', () => {
  assert.equal(
    yuanbaoPages({
      Response: { Pages: ['broken', 'null', JSON.stringify({ title: 'ok', passage: 'text' }), 42] },
    }).length,
    1,
  )
})
test('tool cards use the newest matching release result, own wording and URL identity', () => {
  const pages = yuanbaoPages({
    Response: {
      Pages: [
        {
          title: 'Claude Code v2.1 发布',
          date: '2026-10-29',
          passage: 'release',
          url: 'https://example.com/old',
          site: '发布站',
        },
        {
          title: '<b>Claude Code v2.4 更新</b>',
          date: '2026-10-30',
          passage: 'release',
          url: 'https://example.com/new',
          site: '发布站',
        },
        {
          title: 'Unrelated v9.0',
          date: '2026-10-31',
          passage: 'release',
          url: 'https://example.com/unrelated',
        },
      ].map((value) => JSON.stringify(value)),
    },
  })
  const card = toolCard(pages, 'Claude Code', now)!
  assert.match(card.text, /Claude Code v2.4 更新/)
  assert.doesNotMatch(card.text, /<b>|新版本 9/)
  assert.equal(card.url, 'https://example.com/new')
  assert.equal(card.expiresAt - now, 86400000)
  assert.notEqual(card.id, toolCard([pages[0]!], 'Claude Code', now)!.id)
})
test('holiday parsing requires an official matching notice; news keeps three bounded titles and site names', () => {
  const page = {
    title: '国务院办公厅关于2027年部分节假日安排的通知',
    date: '2026-10-30',
    passage: '国务院办公厅通知',
    url: 'https://www.gov.cn/notice/2027',
    site: '中国政府网',
  }
  const pages = yuanbaoPages({ Response: { Pages: [JSON.stringify(page)] } })
  assert.equal(holidayCard(pages, 2027, now)?.id, 'search:holiday:2027')
  assert.equal(holidayCard(pages, 2028, now), undefined)
  assert.equal(
    holidayCard([{ ...pages[0]!, url: 'https://example.com/notice' }], 2027, now),
    undefined,
  )
  const news = newsCard(
    Array.from({ length: 4 }, (_, i) => ({
      ...pages[0]!,
      title: `${i}${'长标题'.repeat(15)}`,
      site: `站${i}`,
      vr: false,
    })),
    now,
  )!
  assert.equal(news.text.split(' · ').length, 3)
  assert.ok(Array.from(news.text).length <= 120)
  assert.match(news.source, /站0、站1、站2/)
  assert.notEqual(news.id, newsCard(pages, now + 10800000)!.id)
})
test('weather, quote and news identities advance with their data buckets, not the request alone', () => {
  const pages = yuanbaoPages(fixture('weather-m1'))
  const updated = pages.map((page) => ({
    ...page,
    passage: page.passage.replace('30日15:15', '30日17:15'),
  }))
  assert.notEqual(
    weatherCard(pages, '北京', now)!.id,
    weatherCard(updated, '北京', now + 7200000)!.id,
  )
  const stocks = yuanbaoPages(fixture('stock-m1'))
  assert.notEqual(
    stockCard(stocks, '00700.hk', now).id,
    stockCard(
      stocks.map((page) => ({ ...page, passage: page.passage.replace('15:29:10', '15:30:10') })),
      '00700.hk',
      now,
    ).id,
  )
  const gold = yuanbaoPages(fixture('gold-m1'))
  assert.notEqual(
    goldCard(gold, false, now)!.id,
    goldCard(
      gold.map((page) => ({ ...page, passage: page.passage.replace('1793345461', '1793345521') })),
      false,
      now,
    )!.id,
  )
})
test('all six built-in samples are explicitly labelled and never eligible for automatic display', () => {
  for (const topic of ['weather', 'gold', 'stock', 'tools', 'holiday', 'news'] as const) {
    const card = yuanbaoSample(topic, now)
    assert.ok(card.source.endsWith('· 示例'))
    assert.equal(card.score, 0)
    assert.equal(card.topic, topic)
    assert.ok(Array.from(card.text).length <= 120)
  }
})
test('API key client uses only the approved endpoint, exact JSON, bounded timeout and no redirects', async () => {
  let calls = 0,
    timeout = 0
  const client = new YuanbaoClient({
    timeout: (ms) => {
      timeout = ms
      return new AbortController().signal
    },
    transport: async (url, init) => {
      calls++
      assert.equal(url, 'https://api.wsa.cloud.tencent.com/SearchPro')
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.body, JSON.stringify({ Query: '北京今天天气', Mode: 1 }))
      return new Response(JSON.stringify(fixture('weather-m1').response))
    },
  })
  const result = await client.search(
    { Query: '北京今天天气', Mode: 1 },
    { apiKey: 'definitely-fake-api-key' },
  )
  assert.equal(result.edition, 'standard')
  assert.equal(timeout, YUANBAO_TIMEOUT_MS)
  assert.equal(timeout, 8000)
  assert.equal(calls, 1)
})
test('client errors are fixed messages, and transport failures are never retried', async () => {
  for (const [code, expected] of [
    ['AuthFailure.InvalidSecretId', '密钥错误'],
    ['ResourceUnavailable', '未开通或额度用完'],
    ['UnauthorizedOperation', '未开通或额度用完'],
    ['RequestLimitExceeded', '限流，稍后再试'],
    ['InvalidParameter', '参数不被当前版本支持'],
  ]) {
    const client = new YuanbaoClient({
      transport: async () =>
        new Response(
          JSON.stringify({ Response: { Error: { Code: code, Message: 'private server detail' } } }),
        ),
    })
    await assert.rejects(
      client.search({ Query: 'test', Mode: 1 }, { apiKey: 'definitely-fake-api-key' }),
      { message: expected },
    )
  }
  let calls = 0
  const client = new YuanbaoClient({
    transport: async () => {
      calls++
      throw Error('private detail')
    },
  })
  await assert.rejects(
    client.search({ Query: 'test', Mode: 1 }, { apiKey: 'definitely-fake-api-key' }),
    { message: '连接失败' },
  )
  assert.equal(calls, 1)
  const oversized = new YuanbaoClient({
    transport: async () => new Response('x'.repeat(YUANBAO_MAX_BYTES + 1)),
  })
  await assert.rejects(
    oversized.search({ Query: 'test', Mode: 1 }, { apiKey: 'definitely-fake-api-key' }),
    { message: '连接失败' },
  )
  assert.ok(
    Buffer.byteLength(yuanbaoResponseJson({ huge: 'x'.repeat(YUANBAO_MAX_BYTES + 1) })) <
      YUANBAO_MAX_BYTES,
  )
})
test('weather partial update dates cross month boundaries without creating future cache winners', () => {
  const pages = yuanbaoPages(fixture('weather-m1'))
    .filter((page) => page.site === '气象在线')
    .map((page) => ({
      ...page,
      passage: page.passage
        .replace('30日15:15', '31日23:15')
        .replace('日期：2026-10-30', '日期：2026-11-01'),
    }))
  const time = Date.parse('2026-10-31T16:10:00Z'),
    card = weatherCard(pages, '北京', time)!
  assert.equal(card.publishedAt, Date.parse('2026-10-31T15:15:00Z'))
  assert.match(card.id, /2026-11-01/)
  assert.equal(
    weatherCard([{ ...pages[0]!, passage: '# 天气预报：北京\n\n日期：2026-11-01' }], '北京', time),
    undefined,
  )
})
test('client passes the eight-second abort signal through and never retries an abort', async () => {
  const controller = new AbortController()
  let calls = 0
  const client = new YuanbaoClient({
    timeout: (ms) => {
      assert.equal(ms, 8000)
      return controller.signal
    },
    transport: async (_url, init) => {
      calls++
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(Error('private abort details')), {
          once: true,
        })
      })
    },
  })
  const request = client.search({ Query: 'test', Mode: 1 }, { apiKey: 'definitely-fake-api-key' })
  controller.abort()
  await assert.rejects(request, { message: '连接失败' })
  assert.equal(calls, 1)
})

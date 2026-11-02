import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { normalizeAmbient, type AmbientCard, type YuanbaoConfig } from '@codepulse/shared'
import {
  YuanbaoSource,
  type YuanbaoCache,
} from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import {
  goldCard,
  stockCard,
  toolCard,
  newsCard,
  holidayCard,
  weatherCard,
  yuanbaoPages,
  type YuanbaoPage,
} from '../apps/desktop/src/main/ambient-yuanbao.js'

const fetchedAt = Date.parse('2026-11-02T15:36:30Z')
const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/yuanbao/live-${name}.json`, 'utf8'))
const pages = (name: string) => yuanbaoPages(fixture(name))
function source(config: Partial<YuanbaoConfig>, response: unknown, cache?: unknown, failure = '') {
  let saved: YuanbaoCache | undefined
  const service = new YuanbaoSource({
    config: () =>
      normalizeAmbient({
        enabled: true,
        quietStart: 0,
        quietEnd: 0,
        yuanbao: { enabled: true, ...config },
      }),
    now: () => fetchedAt,
    credentials: () => ({ apiKey: 'obviously-fake-live-fixture-key' }),
    holidays: () => ({}),
    hasYear: () => false,
    cache,
    changed() {},
    save: (value) => {
      saved = value
    },
    client: {
      search: async () => {
        if (failure) throw Error(failure)
        return { raw: response, pages: yuanbaoPages(response), latencyMs: 400, edition: 'standard' }
      },
    },
  })
  return { service, saved: () => saved! }
}
const stockConfig = { stocksEnabled: true, stocks: ['aapl.us'] }
const entry = (card: AmbientCard) => ({ key: 'stock:aapl.us', card })

test('live gold preserves domestic, international and brand quotes', () => {
  assert.equal(
    goldCard(pages('gold'), true, fetchedAt)!.text,
    '国内现货金 844.92 元/克 ↑2.01%（+16.62） · 国际 3952.79 美元/盎司 · 周大福 1173元/克',
  )
})
test('live AAPL matches its market and drops the truncated market-cap field', () => {
  const card = stockCard(pages('stock'), 'aapl.us', fetchedAt)
  assert.equal(card.text, '苹果 AAPL.US 340.57 ↓1.18%（-4.06）交易中 · 高 343.78 低 339.61 · 10:24')
  assert.equal(card.score, 1)
  assert.doesNotMatch(card.text, /49703/)
})
test('live tools chooses the newest qualifying article and includes a bounded passage sentence', () => {
  const card = toolCard(pages('tools'), 'Codex', fetchedAt)!
  assert.equal(card.url, 'http://www.mzlw.cn/news/101797')
  assert.match(card.text, /^Codex · Codex 大更新:AGENTS\.md 与 Skills/)
  assert.match(card.text, /：Codex 这次的动作核心就三件事AGENTS\.md/)
  assert.match(card.text, /（尧图网络科技 · 11-02）$/)
  assert.ok(Array.from(card.text.split('：')[1]!.split('（')[0]!).length <= 60)
  assert.ok(Array.from(card.text).length <= 120)
})
for (const token of ['发布', 'changelog', 'v2.4.1']) {
  test(`tool updates accept ${token} as the version-ish release evidence`, () => {
    const page: YuanbaoPage = {
      ...pages('tools')[0]!,
      title: `Codex ${token}`,
      date: '2026-11-02',
      passage: 'Codex 增加了会话筛选功能。',
    }
    const card = toolCard([page], 'Codex', fetchedAt)!
    assert.ok(card)
    assert.match(card.text, /：Codex 增加了会话筛选功能。/)
  })
}
test('bare tool names, unrelated results and stale dated pages do not create update cards', () => {
  const page = {
    ...pages('tools')[0]!,
    title: 'Claude Code',
    passage: 'Claude Code',
    date: '2026-11-02',
  }
  assert.equal(toolCard([page], 'Claude Code', fetchedAt), undefined)
  assert.equal(toolCard(pages('tools'), 'UnrelatedTool', fetchedAt), undefined)
  assert.equal(
    toolCard(
      [{ ...page, title: 'Claude Code v1.2 发布', passage: '增加筛选。', date: '2026-10-20' }],
      'Claude Code',
      fetchedAt,
    ),
    undefined,
  )
})
test('article text about Authorization and missing bearer is retained as ordinary public prose', () => {
  const page = {
    ...pages('tools')[0]!,
    title: 'Codex v2.0 更新',
    date: '2026-11-02',
    passage: 'Codex 修复 Authorization 头错误与 missing bearer 提示。',
  }
  assert.match(toolCard([page], 'Codex', fetchedAt)!.text, /Authorization 头错误与 missing bearer/)
})
test('missing tool releases report the specific tool without a placeholder card', async () => {
  const raw = {
    Response: {
      Pages: [
        JSON.stringify({ title: 'Claude Code', passage: 'Claude Code', site: 'dshpluginhub.ai' }),
      ],
    },
  }
  const f = source({ toolsEnabled: true, tools: ['Claude Code'] }, raw)
  await f.service.tick()
  assert.deepEqual(f.service.cards(), [])
  assert.equal(f.service.snapshot().errors.tools, '近 3 天没有找到 Claude Code 的更新')
})
test('all topic TTLs start at fetch time even when the provider date is old', () => {
  const weatherNow = Date.parse('2026-10-30T07:33:41Z')
  const weatherPages = yuanbaoPages(
    JSON.parse(readFileSync('tests/fixtures/yuanbao/yuanbao-weather-m1.json', 'utf8')),
  ).map((page) => ({ ...page, passage: page.passage.replace('30日15:15', '27日15:15') }))
  const official: YuanbaoPage = {
    title: '国务院办公厅关于2027年部分节假日安排的通知',
    passage: '国务院办公厅通知',
    url: 'https://www.gov.cn/notice/2027',
    date: '2026-10-01',
    site: '中国政府网',
    vr: false,
    category: '',
  }
  for (const [card, at, hours] of [
    [weatherCard(weatherPages, '北京', weatherNow)!, weatherNow, 3],
    [goldCard(pages('gold'), true, fetchedAt)!, fetchedAt, 1],
    [stockCard(pages('stock'), 'aapl.us', fetchedAt), fetchedAt, 1],
    [toolCard(pages('tools').slice(0, 1), 'Codex', fetchedAt)!, fetchedAt, 24],
    [holidayCard([official], 2027, fetchedAt)!, fetchedAt, 7 * 24],
    [newsCard(pages('news'), fetchedAt)!, fetchedAt, 3],
  ] as const) {
    assert.ok(card, 'each parser must produce a card')
    assert.equal(card.expiresAt, at + hours * 3600000, card.topic)
    assert.ok(card.expiresAt > at, card.topic)
  }
})
test('legacy duplicate jobs prefer a valid real card regardless of placeholder order or timestamp', () => {
  const real = stockCard(pages('stock'), 'aapl.us', fetchedAt)
  const missing = stockCard([], 'aapl.us', fetchedAt + 1000)
  for (const entries of [
    [entry(missing), entry(real)],
    [entry(real), entry(missing)],
  ]) {
    const f = source(stockConfig, fixture('stock'), { entries })
    assert.equal(f.service.cards().length, 1)
    assert.equal(f.service.cards()[0]!.id, real.id)
  }
})
test('a successful quote replaces its placeholder by job key in the persisted cache', async () => {
  const f = source(stockConfig, fixture('stock'), {
    entries: [entry(stockCard([], 'aapl.us', fetchedAt))],
  })
  await f.service.tick()
  assert.equal(f.saved().entries.length, 1)
  assert.equal(f.saved().entries[0]!.key, 'stock:aapl.us')
  assert.equal(f.service.cards()[0]!.score, 1)
  assert.match(f.service.cards()[0]!.text, /^苹果 AAPL.US 340.57/)
})
for (const failure of ['', '请求超时']) {
  test(`a later ${failure || 'empty quote'} keeps the still-valid real card and its original expiry`, async () => {
    const real = stockCard(pages('stock'), 'aapl.us', fetchedAt - 900000)
    const f = source(stockConfig, { Response: { Pages: [] } }, { entries: [entry(real)] }, failure)
    await f.service.tick()
    assert.deepEqual(f.service.cards(), [real])
    assert.equal(f.saved().entries.length, 1)
    assert.equal(f.service.snapshot().errors.stock, failure || '未找到 AAPL.US 的行情')
  })
}
test('an expired real card does not hide a newly missing quote', async () => {
  const real = { ...stockCard(pages('stock'), 'aapl.us', fetchedAt), expiresAt: fetchedAt - 1 }
  const f = source(stockConfig, { Response: { Pages: [] } }, { entries: [entry(real)] })
  await f.service.tick()
  assert.equal(f.saved().entries.length, 1)
  assert.equal(f.service.cards()[0]!.score, 0)
})
test('live news excludes vertical quotes, bounds three headlines and removes the site-title footer', () => {
  const card = newsCard(pages('news'), fetchedAt)!
  assert.equal(card.text.split(' · ').length, 2)
  assert.match(card.text, /20项领先科技,透视数智时代创新脉动（光明时政）/)
  assert.match(card.text, /商品服务、实体云端/)
  assert.doesNotMatch(card.text, /統|籌|顧|從|與|時|評|觀|點/)
  assert.doesNotMatch(card.text, /TCL|腾讯自选股|--觀點|--人民網/)
  assert.ok(Array.from(card.text).length <= 120)
})
test('live holiday speculation remains pending without a false published state', async () => {
  assert.equal(holidayCard(pages('holiday'), 2027, fetchedAt), undefined)
  const f = source({ holidayEnabled: true }, fixture('holiday'))
  await f.service.tick()
  assert.deepEqual(f.service.snapshot().holiday, { year: 2027, state: 'pending' })
  assert.deepEqual(f.service.cards(), [])
  assert.equal(f.saved().published['2027'], undefined)
})
test('trimmed live fixtures retain RequestId and only the public parser fields', () => {
  const expected = {
    gold: '2147aa21-74bd-4abc-b001-38103e1cb87e',
    stock: '45fea8a1-a486-4fab-af59-e087183b3232',
    tools: '83f29c3b-d177-4c73-84b6-7eeca0abfa1f',
    news: '8b18d63b-2df4-4af3-bd5d-20cc907d6abc',
    holiday: '534bcf85-b41e-42f9-923a-896503b82f3f',
  }
  for (const [name, id] of Object.entries(expected)) {
    const raw = fixture(name)
    assert.equal(raw.Response.RequestId, id)
    assert.deepEqual(Object.keys(raw.Response).sort(), ['Pages', 'RequestId', 'Version'])
    for (const encoded of raw.Response.Pages) {
      const page = JSON.parse(encoded)
      assert.ok(
        Object.keys(page).every((key) =>
          ['title', 'site', 'url', 'date', 'vr', 'vr_category', 'passage'].includes(key),
        ),
      )
      assert.ok(Array.from(page.passage).length <= 1000)
    }
  }
})

test('live 2: tool updates skip empty summaries, links and install commands', () => {
  const now = Date.parse('2026-11-03T00:00:00+08:00')
  const page = (title: string, passage: string, url: string) => ({
    title, passage, url, site: '示例站', date: '2026-11-02 10:00:00', vr: false, category: '',
  })
  // Seen live: a title-only page whose passage is just the title and a full stop.
  assert.equal(toolCard([page('Claude Code', 'Claude Code。', 'https://example.com/a')], 'Claude Code', now), undefined)
  // Seen live: a label, an install line and a URL, followed by real prose about the release.
  const card = toolCard(
    [page('Codex 发布 0.80 版本', '资讯详情：macOS / Linux 可以这样安装: curl -fsSL https://chatgpt.com/codex/install.sh | sh。新版本把 AGENTS.md 上下文约定和 Skills 机制提到了更重要的位置。', 'https://example.com/b')],
    'Codex',
    now,
  )
  assert.ok(card, 'the release prose still makes a card')
  assert.doesNotMatch(card!.text, /https?:|curl|资讯详情|可以这样安装/)
  assert.match(card!.text, /AGENTS\.md 上下文约定/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { DEVICE_CHARACTERS } from '../apps/desktop/src/main/device-charset.generated.js'
import { deviceText, deviceSupports } from '../apps/desktop/src/main/device-text.js'
import { normalizeAmbient, type AmbientCard } from '@codepulse/shared'
import {
  goldCard,
  stockCard,
  weatherCard,
  toolCard,
  newsCard,
  holidayCard,
  yuanbaoPages,
  type YuanbaoPage,
} from '../apps/desktop/src/main/ambient-yuanbao.js'
import { YuanbaoSource } from '../apps/desktop/src/main/ambient-yuanbao-service.js'
import { collectX, collectMemes, collectNews } from '../apps/desktop/src/main/ambient-sources.js'

const now = Date.parse('2026-11-02T15:36:30Z')
const fixture = (name: string) =>
  JSON.parse(readFileSync(`tests/fixtures/yuanbao/${name}.json`, 'utf8'))
const page = (title: string, passage = ''): YuanbaoPage => ({
  title,
  passage,
  site: '发布站',
  date: '2026-11-02',
  url: 'https://example.com/release',
  vr: false,
  category: '',
})
const renderable = (card: AmbientCard) => {
  assert.equal(deviceSupports(card.text), true, card.text)
  assert.equal(deviceSupports(card.source), true, card.source)
}

test('desktop device character artifact exactly equals every firmware font code point', () => {
  const { codes } = JSON.parse(readFileSync('firmware/fonts/sources/noto-hierarchy.json', 'utf8'))
  assert.deepEqual(
    Array.from(DEVICE_CHARACTERS, (char) => char.codePointAt(0)),
    codes,
  )
  assert.equal(new Set(DEVICE_CHARACTERS).size, codes.length)
  assert.ok(deviceSupports(DEVICE_CHARACTERS))
  execFileSync(process.execPath, ['scripts/generate-device-charset.mjs', '--check'])
})
test('deviceText normalizes half/full-width variants, spaces and invisible characters idempotently', () => {
  const raw = '　ＡＩ１２３！ Ａ｡Ｂ､Ｃ\u00a0Ｄ\tＥ\nＦ\u200bＧ\u200cＨ\u200dＩ\u2060Ｊ\ufeffＫ　'
  const expected = 'AI123! A。B、C D E FGHIJK'
  assert.equal(deviceText(raw), expected)
  assert.equal(deviceText(deviceText(raw)), expected)
  assert.equal(deviceText('e\u0301'), 'é')
  assert.equal(deviceText(undefined), '')
  assert.ok(deviceSupports(deviceText(raw)))
})
test('deviceSupports rejects every unsupported scalar, including traditional Han and emoji', () => {
  for (const text of ['､', '｡', '統籌兼顧', '從與時評觀點', '😀', '𠮷', 'e\u0301', '\n'])
    assert.equal(deviceSupports(text), false, text)
  assert.equal(deviceSupports(''), true)
  assert.equal(deviceSupports(deviceText('科技､新闻｡')), true)
})
test('live news skips the unsupported traditional-script headline and normalizes the half-width comma', () => {
  const card = newsCard(yuanbaoPages(fixture('live-news')), now)!
  assert.equal(
    card.text,
    '20项领先科技,透视数智时代创新脉动（光明时政） · 商品服务、实体云端,科技重新定义商贸场景 激活终端消费…（中国青年网）',
  )
  assert.equal(card.source, '元宝搜索 · 光明时政、中国青年网')
  renderable(card)
})
test('news selects the first three supported full headlines, checking before truncation and de-duplicating normalized variants', () => {
  const card = newsCard(
    [
      page('简体' + '新'.repeat(50) + '統'),
      page('科技､发布'),
      page('科技、发布'),
      page('不可显示😀'),
      page('ＡＩ版本２发布'),
      page('安全的第三条标题'),
      page('安全的第四条标题'),
    ],
    now,
  )!
  assert.equal(
    card.text,
    '科技、发布（发布站） · AI版本2发布（发布站） · 安全的第三条标题（发布站）',
  )
  renderable(card)
})
test('news with no renderable titles produces no card and the specified source error', async () => {
  assert.equal(newsCard([page('統籌兼顧'), page('😀')], now), undefined)
  const service = new YuanbaoSource({
    config: () =>
      normalizeAmbient({
        enabled: true,
        quietStart: 0,
        quietEnd: 0,
        yuanbao: { enabled: true, newsEnabled: true },
      }),
    credentials: () => ({ apiKey: 'obviously-fake-font-test-key' }),
    now: () => now,
    holidays: () => ({}),
    hasYear: () => false,
    save() {},
    changed() {},
    client: {
      search: async () => ({
        raw: {},
        pages: [page('統籌兼顧'), page('😀')],
        latencyMs: 0,
        edition: 'standard',
      }),
    },
  })
  await service.tick()
  assert.deepEqual(service.cards(), [])
  assert.equal(service.snapshot().errors.news, '没有可在墨水屏显示的标题')
})
test('tools try the next candidate when a complete title or sentence contains unsupported text', () => {
  const accepted = {
    ...page('Ｃｏｄｅｘ v2.1 更新', 'Codex 新增了会话筛选功能并修复多个连接问题。'),
    date: '2026-11-02 10:00:00',
    url: 'https://example.com/good',
  }
  const title = {
    ...page('Codex v3.2 統', 'Codex 新增了会话筛选功能并修复多个连接问题。'),
    date: '2026-11-02 20:00:00',
  }
  const sentence = {
    ...page('Codex v3.1 更新', 'Codex 新增了会话筛选功能并統一管理多个工作目录。'),
    date: '2026-11-02 19:00:00',
  }
  for (const unsupported of [title, sentence]) {
    const card = toolCard([unsupported, accepted], 'Ｃｏｄｅｘ', now)!
    assert.equal(card.url, accepted.url)
    assert.match(card.text, /^Codex · Codex v2.1 更新/)
    renderable(card)
  }
  assert.equal(toolCard([title, sentence], 'Codex', now), undefined)
})
test('weather normalizes numeric fields and drops the entire unsupported optional field', () => {
  const weatherNow = Date.parse('2026-10-30T07:33:41Z')
  const weather: YuanbaoPage = {
    ...page('天气预报'),
    vr: true,
    category: 'weather',
    site: '气象在线',
    passage:
      '# 天气预报：北京\n# 更新时间：2026-10-30 15:15\n\n日期：2026-10-30\n当天天气状态：晴\n最低温度（摄氏度）：４\n最高温度（摄氏度）：２２\n体感温度（摄氏度）：１５😀\n当天风向：西北😀\n当天风级：3级\n湿度：３２\n空气质量：６０\n尾号限行：４和９\n日落时间：１７：１５\n\n日期：2026-10-31\n当天天气状态：多云😀\n最低温度（摄氏度）：６\n最高温度（摄氏度）：１２',
  }
  const card = weatherCard([weather], '北\u200b京　', weatherNow)!
  assert.match(card.text, /^北京 今天 晴 4–22℃/)
  assert.match(card.text, /湿度32% · 空气60 · 限行4和9 · 日落17:15/)
  assert.match(card.text, /明天 6–12℃/)
  assert.doesNotMatch(card.text, /体感|西北|3级|多云|😀/)
  renderable(card)
})
test('gold normalizes spot numbers and omits unrenderable brand and international fields', () => {
  const gold = yuanbaoPages(fixture('yuanbao-gold-m1')).map((value) => ({
    ...value,
    passage: value.passage
      .replace('852.80', '８５２.８０')
      .replaceAll('周大福', '周大福😀')
      .replace('3984.98', '3984.98😀'),
  }))
  const card = goldCard(gold, true, now)!
  assert.match(card.text, /国内现货金 852.80 元\/克/)
  assert.doesNotMatch(card.text, /国际|周大福|😀/)
  renderable(card)
})
test('stock normalizes code, price and change fields while dropping unsupported name, status and high', () => {
  const stock: YuanbaoPage = {
    ...page('苹果'),
    vr: true,
    category: 'stock',
    passage:
      '# 股票：苹果\n# 股票代码：ＡＡＰＬ\n# 股票代码前缀：ｕｓ\n# 股票名称：苹果😀\n# 实时股价：３４０.５７\n# 涨跌额：－４.０６\n# 涨跌幅：－１.１８\n# 交易状态：交易統中\n# 今日最高价：３４３😀\n# 今日最低价：３３９.６１\n# 更新时间：２０２６－１１－０２ １０：２４：５０',
  }
  const card = stockCard([stock], 'aapl.us', now)
  assert.match(card.text, /^AAPL.US 340.57 ↓1.18%（-4.06）/)
  assert.match(card.text, /低 339.61/)
  assert.doesNotMatch(card.text, /苹果|交易|高|😀|統/)
  assert.equal(card.score, 1)
  renderable(card)
})
test('holiday normalizes a full-width year/date and sanitizes its publisher', () => {
  const card = holidayCard(
    [
      {
        ...page('国务院办公厅关于２０２７年部分节假日安排的通知', '国务院办公厅通知'),
        url: 'https://www.gov.cn/notices/2027',
        site: '中国政府网\u200b',
        date: '２０２６－１１－０２',
      },
    ],
    2027,
    now,
  )!
  assert.ok(card)
  assert.match(card.text, /^2027 年放假安排已发布/)
  renderable(card)
})
test('a supported headline remains usable when only its publisher cannot be rendered', () => {
  const card = newsCard([{ ...page('支持显示的标题'), site: '統籌😀' }], now)!
  assert.ok(card.text.includes('支持显示的标题'))
  assert.doesNotMatch(card.text + card.source, /統|籌|😀/)
  renderable(card)
})
test('restored Yuanbao caches repair common variants and discard still-unsupported text', () => {
  const card = newsCard([page('测试标题')], now)!
  const restore = (text: string) =>
    new YuanbaoSource({
      config: () => normalizeAmbient({ yuanbao: { newsEnabled: true } }),
      credentials: () => null,
      now: () => now,
      holidays: () => ({}),
      hasYear: () => false,
      changed() {},
      save() {},
      cache: { entries: [{ key: 'news:科技', card: { ...card, text } }] },
    })
  const repaired = restore('科技､发布').cards()
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0]!.text, '科技、发布')
  renderable(repaired[0]!)
  assert.deepEqual(restore('統籌兼顧').cards(), [])
})
test('X, meme captions and HN retain their existing text policy in this round', async () => {
  const title = '統籌😀､'
  const config = normalizeAmbient(undefined)
  const [x] = await collectX(
    { ...config, provider: 'twitterapi' },
    'obviously-fake-source-key',
    now,
    async () => ({
      tweets: [
        {
          id: '12345',
          author: { userName: 'example' },
          text: title,
          createdAt: new Date(now).toISOString(),
          likeCount: 500,
        },
      ],
    }),
  )
  const [meme] = await collectMemes(config, now, async () => ({
    memes: [
      {
        nsfw: false,
        spoiler: false,
        postLink: 'https://redd.it/abc123',
        url: 'https://i.redd.it/abc.png',
        title,
        subreddit: 'example',
        ups: 500,
      },
    ],
  }))
  const [hn] = await collectNews(now, async () => ({
    hits: [{ objectID: '12345', created_at_i: now / 1000, points: 200, title }],
  }))
  assert.equal(x!.text, title)
  assert.equal(meme!.text, title)
  assert.equal(hn!.text, title)
})

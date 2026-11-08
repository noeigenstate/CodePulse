// In-memory stand-in for the platform API, used by `?mock=1` in dev to build and screenshot the
// pages without the server. Never imported by production code (see main.tsx).
import type { PluginCard, PluginKind, PluginListing, PluginSetting } from '@codepulse/shared'
import type { Api, DevPlugin, Developer, InstallRow, Review } from './api'

const minutes = (n: number) => Date.now() - n * 60000
const later = () => Date.now() + 3600000

const hnSettings: PluginSetting[] = [
  {
    key: 'count',
    label: '条数',
    type: 'select',
    default: '4',
    options: [
      { value: '4', label: '4 条' },
      { value: '3', label: '3 条' },
      { value: '2', label: '2 条' },
    ],
  },
  { key: 'minPoints', label: '最低分数', type: 'number', default: 100, min: 0, max: 999 },
  { key: 'weekdays', label: '只在工作日显示', type: 'boolean', default: false },
]

const listing = (
  id: string,
  name: string,
  developer: string,
  kind: PluginKind,
  version: string,
  installs: number,
  summary: string,
  settings: PluginSetting[] = [],
): PluginListing => ({
  id,
  name,
  summary,
  description: `${summary}卡片由平台在云端生成，桌面端只拉取和显示，插件代码不会在电脑或设备上运行。`,
  kind,
  version,
  developer,
  installs,
  settings,
  updatedAt: minutes(3000),
})

const official = 'CodePulse 官方'
const plugins: PluginListing[] = [
  listing(
    'codepulse.hn-digest',
    'Hacker News 摘要',
    official,
    'builtin',
    '1.0.0',
    1200,
    '每 2 小时取首页前四条，显示标题、分数和评论数。',
    hnSettings,
  ),
  listing(
    'codepulse.poem',
    '每日古诗',
    official,
    'pack',
    '1.1.0',
    860,
    '每天一首短诗，附作者和朝代。',
  ),
  listing(
    'wordaday.word',
    '每日一词',
    'wordaday',
    'pack',
    '1.2.0',
    312,
    '每天一个英文单词，附释义和例句。',
  ),
  listing(
    'trendbot.gh',
    'GitHub 趋势',
    'trendbot',
    'webhook',
    '0.4.0',
    540,
    '按语言筛选当天的热门仓库。',
    [{ key: 'lang', label: '语言', type: 'text', default: 'TypeScript', maxLength: 20 }],
  ),
  listing(
    'fxdesk.rate',
    '汇率',
    'fxdesk',
    'webhook',
    '2.0.1',
    205,
    '人民币兑美元、日元、欧元，含当日涨跌。',
  ),
  listing(
    'codepulse.focus',
    '专注统计',
    official,
    'builtin',
    '0.9.0',
    97,
    '今天专注了多久，和昨天比较。',
  ),
]

const card = (
  id: string,
  source: string,
  text: string,
  rest: Partial<PluginCard> = {},
): PluginCard => ({
  id,
  source,
  text,
  expiresAt: later(),
  ...rest,
})

const previews: Record<string, PluginCard> = {
  'codepulse.hn-digest': card('hn', 'Hacker News', '812 分 · A 1-bit e-paper desk dashboard', {
    life: {
      v: 1,
      kind: 'hn',
      updated: '14:20',
      stories: [
        {
          title: 'Show HN: A 1-bit e-paper desk dashboard',
          points: 812,
          comments: 214,
          site: 'github.com',
          age: '2h',
        },
        {
          title: 'SQLite is enough for most platforms',
          points: 655,
          comments: 301,
          site: 'sqlite.org',
          age: '3h',
        },
        {
          title: 'The quiet return of webhooks',
          points: 430,
          comments: 98,
          site: 'blog.example',
          age: '4h',
        },
        {
          title: 'Why ESP32-S3 boards run warm',
          points: 301,
          comments: 77,
          site: 'espressif.com',
          age: '5h',
        },
      ],
    } as PluginCard['life'],
  }),
  'codepulse.poem': card(
    'poem',
    '每日古诗',
    '床前明月光，疑是地上霜。举头望明月，低头思故乡。——李白《静夜思》',
  ),
  'wordaday.word': card('word', '每日一词', 'serendipity：意外发现美好事物的运气。'),
  'fxdesk.rate': card('rate', '汇率', '', {
    items: [
      { title: 'USD/CNY 7.12', meta: '+0.2%', overdue: false },
      { title: 'JPY/CNY 0.047', meta: '-0.4%', overdue: true },
    ],
  }),
  'codepulse.focus': card('focus', '专注统计', '位图', { imageHex: '0'.repeat(19968) }),
}

let installs: InstallRow[] = [
  {
    pluginId: 'codepulse.hn-digest',
    enabled: true,
    settings: { count: '4', minPoints: 100, weekdays: false },
    installedAt: minutes(900),
    status: { generatedAt: minutes(5), error: '' },
  },
  {
    pluginId: 'codepulse.poem',
    enabled: true,
    settings: {},
    installedAt: minutes(800),
    status: { generatedAt: minutes(32), error: '接口返回的卡片格式不对' },
  },
]

const developer: Developer = { email: 'dev@example.com', name: '示例开发者', admin: true }
const devPlugins: DevPlugin[] = [
  {
    id: 'wordaday.word',
    name: '每日一词',
    summary: '每天一个英文单词',
    liveVersion: '1.2.0',
    versions: [
      {
        id: 'v1',
        version: '1.2.0',
        kind: 'pack',
        state: 'approved',
        note: '',
        submittedAt: minutes(5000),
      },
      {
        id: 'v2',
        version: '1.3.0',
        kind: 'pack',
        state: 'pending',
        note: '',
        submittedAt: minutes(120),
      },
    ],
  },
  {
    id: 'wordaday.air',
    name: '城市空气',
    summary: '城市空气质量',
    liveVersion: null,
    versions: [
      {
        id: 'v3',
        version: '0.1.0',
        kind: 'webhook',
        state: 'rejected',
        note: '接口 5 秒内没有响应',
        submittedAt: minutes(9000),
      },
    ],
  },
]
let reviews: Review[] = [
  {
    versionId: 'v2',
    pluginId: 'wordaday.word',
    pluginName: '每日一词',
    version: '1.3.0',
    kind: 'pack',
    developer: developer.email,
    submittedAt: minutes(120),
    cardCount: 30,
    endpoint: null,
  },
]

const ok = <T>(value: T) => Promise.resolve(structuredClone(value))
const authed = { token: 'mock', developer }

export const mockApi: Api = {
  storeSession: () => ok({ token: 'mock' }),
  plugins: () => ok(plugins),
  preview: (id) => ok({ cards: previews[id] ? [previews[id]] : [], error: '' }),
  installs: () => ok(installs),
  putInstall: (id, change) => {
    const current = installs.find((i) => i.pluginId === id)
    const next: InstallRow = {
      pluginId: id,
      enabled: true,
      settings: {},
      installedAt: Date.now(),
      status: { generatedAt: null, error: '' },
      ...current,
      ...change,
    } as InstallRow
    installs = [...installs.filter((i) => i !== current), next]
    return ok({ install: next })
  },
  deleteInstall: (id) => {
    installs = installs.filter((i) => i.pluginId !== id)
    return ok({ ok: true as const })
  },
  devRegister: () => ok(authed),
  devLogin: () => ok(authed),
  devLogout: () => ok({ ok: true as const }),
  devMe: () => ok(developer),
  devPlugins: () => ok(devPlugins),
  createPlugin: (body) => {
    devPlugins.push({ ...body, liveVersion: null, versions: [] })
    return ok({ plugin: body, webhookSecret: 'whsec_4f9c1e7a2b6d83f05a91' })
  },
  submitVersion: (id, draft) => {
    const version = {
      id: `v${Date.now()}`,
      version: draft.manifest.version,
      state: 'pending' as const,
    }
    devPlugins
      .find((p) => p.id === id)
      ?.versions.push({ ...version, kind: draft.manifest.kind, note: '', submittedAt: Date.now() })
    return ok({ version })
  },
  testPlugin: (_id, draft) =>
    ok({
      cards: (draft.cards ?? []).map((c, i) => ({ ...card(`t-${i}`, '', ''), ...(c as object) })),
      error: draft.endpoint ? '接口 5 秒内没有响应' : '',
    }),
  reviews: () => ok(reviews),
  decide: (versionId) => {
    reviews = reviews.filter((r) => r.versionId !== versionId)
    return ok({ ok: true as const })
  },
}

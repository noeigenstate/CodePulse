// Synthetic, user-approved B study values. No accounts, secrets or live requests.
import { readFileSync, writeFileSync } from 'node:fs'
const base = {
  protocolVersion: 1,
  revision: 'life-B',
  mainState: 'idle',
  agents: [
    {
      type: 'claude_code',
      state: 'idle',
      quotas: [],
      quotaSummary: { fiveHourUsedPercent: 17, weeklyUsedPercent: 2 },
    },
    {
      type: 'codex',
      state: 'idle',
      quotas: [],
      quotaSummary: { fiveHourUsedPercent: null, weeklyUsedPercent: 87 },
    },
  ],
  display: {
    version: 1,
    mode: 'hud',
    metric: 'remaining',
    showQuota: true,
    showEnvironment: true,
    agents: ['claude_code', 'codex'],
    page: 0,
  },
  threadTotal: 0,
  threads: [],
}
const stock = {
  v: 1,
  kind: 'stock',
  name: '苹果',
  symbol: 'AAPL.US',
  hero: '341.24',
  direction: 'down',
  state: 'open',
  percent: '0.98%',
  change: '-3.39',
  low: '339.61',
  high: '343.78',
  open: '342.67',
  previous: '344.63',
  source: '腾讯自选股',
}
const tool = {
  v: 1,
  kind: 'tool',
  icon: 'codex',
  name: 'Codex',
  date: '11-02',
  source: '编程知识',
  command: 'codex doctor',
  title: 'Codex 运行时健康检查',
  summary: '用来检查本地安装、配置、认证和运行时健康状态。',
}
const holiday = {
  v: 1,
  kind: 'holiday',
  year: 2027,
  state: 'pending',
  label: '',
  next: { name: '元旦', date: '2027-01-01', days: 59 },
}
export const LIFE_FIXTURES = {
  weather: {
    v: 1,
    kind: 'weather',
    icon: 'sun',
    place: '北京',
    low: '3',
    high: '17',
    condition: '晴',
    feels: '5',
    wind: '西南风 · 微风',
    humidity: '39',
    air: '91',
    restriction: '5和0',
    sunset: '17:12',
    tomorrow: { icon: 'sun', low: '5', high: '19', condition: '晴' },
  },
  gold: {
    v: 1,
    kind: 'gold',
    hero: '844.92',
    direction: 'up',
    percent: '2.01%',
    change: '+16.62',
    low: '829.39',
    high: '847.78',
    international: '3952.79',
    internationalPercent: '+2.01%',
    brand: '周大福',
    brandPrice: '1173',
    source: '金投网',
  },
  'stock-down': stock,
  'stock-up': {
    ...stock,
    name: '腾讯控股',
    symbol: '00700.HK',
    hero: '612.50',
    direction: 'up',
    percent: '1.24%',
    change: '+7.50',
    low: '603.50',
    high: '614.00',
    open: '605.00',
    previous: '605.00',
    source: '腾讯自选股 · 示例',
  },
  'stock-closed': { ...stock, state: 'closed' },
  'tool-codex': tool,
  'tool-claude': {
    ...tool,
    icon: 'claude',
    name: 'Claude Code',
    date: '示例文本',
    command: '/compact',
    title: 'Claude Code 对话摘要（示例）',
    summary: '在对话变长时压缩上下文，保留要点并释放窗口空间。',
  },
  news: {
    v: 1,
    kind: 'news',
    headlines: [
      { title: '20项领先科技…', source: '光明时政' },
      { title: '商品服务、实体云端…', source: '中国青年网' },
      { title: '示例标题：本地新闻摘要…', source: '示例来源' },
      { title: '示例标题：行业动态速递…', source: '示例来源' },
    ],
  },
  'holiday-none': holiday,
  'holiday-yes': {
    ...holiday,
    state: 'published',
    label: '示例',
    range: { name: '元旦', start: '2027-01-01', end: '2027-01-03', days: 3 },
  },
}
if (process.argv.includes('--write') || process.argv.includes('--check')) {
  for (const [name, life] of Object.entries(LIFE_FIXTURES)) {
    const value = {
      ...base,
      ambient: {
        id: 'life-' + name,
        source: '元宝搜索 · 示例',
        text: name + ' · 兼容旧固件的文字内容（合成排版样例）',
        layout: 'life',
        life,
      },
    }
    const path = new URL(`./fixtures/life-${name}.json`, import.meta.url),
      text = JSON.stringify(value, null, 2) + '\n'
    if (process.argv.includes('--write')) writeFileSync(path, text)
    else if (readFileSync(path, 'utf8') !== text) throw Error('Stale life fixture: ' + name)
  }
  console.log('Verified/generated ten synthetic life fixtures')
}

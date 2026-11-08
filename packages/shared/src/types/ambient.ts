import type { DeviceLife } from './life.js'
/** Pixel pets drawn for the multimedia area. Names and art live in the desktop main process. */
export const PET_IDS = ['tuantuan', 'yaya', 'fangfang', 'rongrong', 'lulu'] as const
export type PetId = (typeof PET_IDS)[number]
export const PET_MOODS = ['idle', 'working', 'hungry', 'happy', 'sleepy'] as const
export type PetMood = (typeof PET_MOODS)[number]
/** Names and one-line character notes, shown on the page and on the device card source line. */
export const PET_PROFILES: Record<PetId, { name: string; trait: string }> = {
  tuantuan: { name: '团团', trait: '嘴硬心软的小猫' },
  yaya: { name: '芽芽', trait: '叶子会说心情' },
  fangfang: { name: '方方', trait: '屏幕上演情绪' },
  rongrong: { name: '绒绒', trait: '尾巴会摇的机灵鬼' },
  lulu: { name: '噜噜', trait: '爱吃爱睡的小胖猪' },
}
/** Profile for any value that claims to be a pet id; unknown or missing ids fall back to the first pet. */
export function petProfile(id: unknown): { name: string; trait: string } {
  return PET_PROFILES[PET_IDS.find((known) => known === id) ?? PET_IDS[0]]
}
/** What each mood means, in the order the desktop checks them. */
export const PET_MOOD_LABELS: Record<PetMood, { label: string; hint: string }> = {
  sleepy: { label: '犯困', hint: '23:00–次日 7:00' },
  hungry: { label: '饿了', hint: '任一额度剩余 20% 以下' },
  working: { label: '陪你干活', hint: 'Agent 正在工作' },
  happy: { label: '开心', hint: '2 小时内刚完成任务' },
  idle: { label: '悠闲', hint: '其余时候' },
}
/**
 * Red ink for a multimedia bitmap, in the 384 x 208 picture-area coordinates.
 * `x` and `w` are multiples of 8, `w * h / 8 <= 3072`, and `hex` holds exactly `w * h / 4`
 * characters (row-major, MSB first, 1 = red). It never overlaps `imageHex`'s black.
 */
export interface AmbientRedPlane {
  x: number
  y: number
  w: number
  h: number
  hex: string
}
/** Mood text for any value that claims to be a mood; unknown ids read as idle. */
export function petMoodLabel(mood: unknown): { label: string; hint: string } {
  return PET_MOOD_LABELS[PET_MOODS.find((known) => known === mood) ?? 'idle']
}
export const AMBIENT_RED_MAX_BYTES = 3072

/**
 * Month calendar for the device (firmware 0.0.29+). `first` is Monday-based (0 = Monday) and
 * `today` is 0 when today is not in `month`. `labels` and `flags` both hold one entry per day:
 * flag 1 red date number, 2 red small text, 4 official day off, 8 make-up workday (4 and 8 are
 * mutually exclusive). Labels are at most four Han characters.
 */
export interface DeviceCalendar {
  year: number
  month: number
  today: number
  first: number
  days: number
  lunar: string
  week: number
  labels: string[]
  flags: number[]
}
/** Where the next official holiday is, computed by the desktop from the holiday table in use. */
export interface CalendarNextHoliday {
  name: string
  /** Local date of the first day off, YYYY-MM-DD. */
  date: string
  /** Days from today to that date; 0 when today is the first day off. */
  inDays: number
  /** Today already falls inside the break. */
  ongoing: boolean
}

/** 元宝搜索 (Tencent Cloud WSA SearchPro) — features that feed desk cards. */
export type YuanbaoTopic = 'weather' | 'gold' | 'stock' | 'tools' | 'holiday' | 'news'
export interface YuanbaoConfig {
  /** Master switch; nothing is requested without a saved key either. */
  enabled: boolean
  weatherEnabled: boolean
  city: string
  goldEnabled: boolean
  /** Adds the first brand price (e.g. 周大福) as a second line. */
  goldBrand: boolean
  stocksEnabled: boolean
  /** Up to 3, lower-case `<code>.<market>`: `00700.hk`, `600519.sh`, `000001.sz`, `aapl.us`. */
  stocks: string[]
  toolsEnabled: boolean
  /** Up to 4 tool names searched for release news. */
  tools: string[]
  holidayEnabled: boolean
  newsEnabled: boolean
  newsTopic: string
  /** Requests per local day across all features, 1–200. */
  dailyRequestLimit: number
}
export const DEFAULT_YUANBAO: YuanbaoConfig = {
  enabled: false,
  weatherEnabled: false,
  city: '北京',
  goldEnabled: false,
  goldBrand: true,
  stocksEnabled: false,
  stocks: ['00700.hk'],
  toolsEnabled: false,
  tools: ['Claude Code', 'Codex'],
  holidayEnabled: false,
  newsEnabled: false,
  newsTopic: '科技',
  dailyRequestLimit: 48,
}
export type YuanbaoAuthMode = 'tc3' | 'apikey'
/** Renderer → main only; the main process never sends a key back. Empty strings clear it. */
export interface YuanbaoKeyInput {
  secretId?: string
  secretKey?: string
  apiKey?: string
}
export interface YuanbaoStatus {
  hasKey: boolean
  authMode: YuanbaoAuthMode | null
  requestsToday: number
  limit: number
  lastLatencyMs: number | null
  lastError: string
  errors: Partial<Record<YuanbaoTopic, string>>
  lastCheckedAt: number
  /** Edition reported by the API: 'lite' | 'standard' | 'flagship'. */
  edition: string | null
  /** Site names behind the current cards, e.g. 气象在线、金投网、腾讯自选股. */
  sources: string[]
  holiday: { year: number; state: 'published' | 'pending' | 'synced' } | null
}
export interface YuanbaoTestResult {
  ok: boolean
  latencyMs: number | null
  edition: string | null
  /** The parsed weather line on success. */
  cardText: string
  error: string
}
/** Optional, low-priority desk content. Credentials never cross back to the renderer. */
export interface AmbientConfig {
  version: 1
  enabled: boolean
  xEnabled: boolean
  memeEnabled: boolean
  conceptsEnabled: boolean
  promptsEnabled: boolean
  newsEnabled: boolean
  petEnabled: boolean
  petId: PetId
  calendarEnabled: boolean
  provider: 'twitterapi' | 'x'
  accounts: string[]
  keywords: string[]
  exclude: string[]
  minLikes: number
  accountMinLikes: Record<string, number>
  memeMinUps: number
  memeCommunity: 'memes' | 'dankmemes' | 'ProgrammerHumor'
  pollMinutes: number
  gapMinutes: number
  dailyLimit: number
  dailyRequestLimit: number
  displayMinutes: number
  quietStart: number
  quietEnd: number
  idleOnly: boolean
  /** 元宝搜索 features; see YuanbaoConfig. */
  yuanbao: YuanbaoConfig
}
export const DEFAULT_AMBIENT: AmbientConfig = {
  version: 1,
  enabled: false,
  xEnabled: true,
  memeEnabled: true,
  conceptsEnabled: true,
  promptsEnabled: false,
  newsEnabled: false,
  petEnabled: true,
  petId: PET_IDS[0],
  calendarEnabled: true,
  provider: 'twitterapi',
  accounts: ['Polymarket', 'elonmusk', 'OpenAI', 'AnthropicAI', 'GoogleDeepMind'],
  keywords: [],
  exclude: ['giveaway', 'airdrop', 'promo code'],
  minLikes: 5000,
  accountMinLikes: { elonmusk: 50000 },
  memeMinUps: 1000,
  memeCommunity: 'memes',
  pollMinutes: 30,
  gapMinutes: 90,
  dailyLimit: 6,
  dailyRequestLimit: 24,
  displayMinutes: 10,
  quietStart: 23,
  quietEnd: 8,
  idleOnly: true,
  yuanbao: DEFAULT_YUANBAO,
}
export interface AmbientCard {
  /** Optional production-rendered checklist; old firmware uses the text fallback. */
  items?: { title: string; meta: string; overdue: boolean }[]
  id: string
  kind:
    | 'x'
    | 'meme'
    | 'concept'
    | 'prompt'
    | 'note'
    | 'image'
    | 'news'
    | 'pet'
    | 'calendar'
    | 'life'
    | 'search'
    | 'plugin'
  /** 元宝搜索 cards only: which feature produced it ('life' kind: weather/gold/stock; 'search' kind: tools/holiday/news). */
  topic?: YuanbaoTopic
  plugin?: { id: string }
  source: string
  text: string
  url: string
  publishedAt: number
  expiresAt: number
  score: number
  imageUrl?: string
  /** 384 x 208, row-major, MSB first; 1 = black. No external image requests on device. */
  imageHex?: string
  /** Red ink on top of `imageHex`; only cards with a bitmap may carry it. */
  red?: AmbientRedPlane
  /** Additive firmware layouts; life cards retain text for older firmware. */
  layout?: 'pet' | 'calendar' | 'life'
  life?: DeviceLife
  /** Pet cards only: which pet this is and the mood it was drawn for. */
  pet?: { id: PetId; mood: PetMood }
  /** Calendar cards only: the month grid the device draws (no bitmap). */
  calendar?: DeviceCalendar
}
export interface DeviceAmbientCard {
  /** Up to six rows; absent means the original text/image presentation. */
  items?: { title: string; meta: string; overdue: boolean }[]
  /** Explicit temporary display may cover review notices; action/fault still win. */
  manual?: boolean
  id: string
  source: string
  text: string
  imageHex?: string
  /** Optional; devices drop it (and show black only) if it is invalid. */
  red?: AmbientRedPlane
  /** pet (0.0.28+), calendar (0.0.29+), life (0.0.30+). Unknown layouts render the legacy text. */
  layout?: 'pet' | 'calendar' | 'life'
  life?: DeviceLife
  /** Optional; firmware drops an invalid one and shows `text` as a plain card. */
  calendar?: DeviceCalendar
}
export interface AmbientSnapshot {
  config: AmbientConfig
  hasKey: boolean
  collecting: boolean
  lastCheckedAt: number
  nextCheckAt: number
  /** Earliest possible automatic display today; null if disabled, capped or currently unpredictable. */
  nextAutoAt: number | null
  sourceStatus: { x: string; meme: string; news?: string }
  /** Next official holiday from the holiday table in use; absent when none is known. */
  calendarNext?: CalendarNextHoliday
  cards: AmbientCard[]
  activeId: string | null
  shownToday: number
  xRequestsToday: number
  pausedReason: string
  /** 元宝搜索 status; never contains credentials. Absent on hosts without the source. */
  yuanbao?: YuanbaoStatus
}
export function normalizeAmbient(value: unknown): AmbientConfig {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const bool = (key: keyof AmbientConfig) =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : (DEFAULT_AMBIENT[key] as boolean)
  const num = (key: keyof AmbientConfig, min: number, max: number) =>
    typeof v[key] === 'number' && Number.isFinite(v[key])
      ? Math.max(min, Math.min(max, Math.round(v[key] as number)))
      : (DEFAULT_AMBIENT[key] as number)
  const words = (key: 'accounts' | 'keywords' | 'exclude') =>
    Array.isArray(v[key])
      ? [
          ...new Set(
            (v[key] as unknown[])
              .filter((s): s is string => typeof s === 'string')
              .map((s) => s.trim().slice(0, 60))
              .filter(Boolean),
          ),
        ].slice(0, 12)
      : [...DEFAULT_AMBIENT[key]]
  const overrides =
    v.accountMinLikes && typeof v.accountMinLikes === 'object'
      ? (v.accountMinLikes as Record<string, unknown>)
      : DEFAULT_AMBIENT.accountMinLikes
  const accountMinLikes = Object.fromEntries(
    Object.entries(overrides)
      .filter(
        ([key, value]) =>
          /^[A-Za-z0-9_]{1,15}$/.test(key) && typeof value === 'number' && Number.isFinite(value),
      )
      .slice(0, 12)
      .map(([key, value]) => [
        key.toLowerCase(),
        Math.max(0, Math.min(1000000, Math.round(value as number))),
      ]),
  )
  return {
    version: 1,
    enabled: bool('enabled'),
    xEnabled: bool('xEnabled'),
    memeEnabled: bool('memeEnabled'),
    conceptsEnabled: bool('conceptsEnabled'),
    promptsEnabled: bool('promptsEnabled'),
    newsEnabled: bool('newsEnabled'),
    petEnabled: bool('petEnabled'),
    petId: PET_IDS.find((id) => id === v.petId) ?? DEFAULT_AMBIENT.petId,
    calendarEnabled: bool('calendarEnabled'),
    provider: v.provider === 'x' ? 'x' : 'twitterapi',
    accounts: words('accounts')
      .map((s) => s.replace(/^@/, ''))
      .filter((s) => /^[A-Za-z0-9_]{1,15}$/.test(s)),
    keywords: words('keywords'),
    exclude: words('exclude'),
    minLikes: num('minLikes', 0, 1000000),
    accountMinLikes,
    memeMinUps: num('memeMinUps', 0, 1000000),
    memeCommunity:
      v.memeCommunity === 'dankmemes' || v.memeCommunity === 'ProgrammerHumor'
        ? v.memeCommunity
        : 'memes',
    pollMinutes: num('pollMinutes', 15, 1440),
    gapMinutes: num('gapMinutes', 30, 1440),
    dailyLimit: num('dailyLimit', 1, 24),
    dailyRequestLimit: num('dailyRequestLimit', 1, 96),
    displayMinutes: num('displayMinutes', 1, 30),
    quietStart: num('quietStart', 0, 23),
    quietEnd: num('quietEnd', 0, 23),
    idleOnly: bool('idleOnly'),
    yuanbao: normalizeYuanbao(v.yuanbao),
  }
}

const YUANBAO_STOCK = /^[a-z0-9]{1,10}\.(hk|sh|sz|us)$/
/** Validates 元宝搜索 settings; unknown or malformed values fall back to the defaults. */
export function normalizeYuanbao(value: unknown): YuanbaoConfig {
  const v = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const bool = (key: keyof YuanbaoConfig) =>
    typeof v[key] === 'boolean' ? (v[key] as boolean) : (DEFAULT_YUANBAO[key] as boolean)
  const text = (key: 'city' | 'newsTopic', max: number) => {
    const raw =
      typeof v[key] === 'string' ? (v[key] as string).replace(/\s+/g, ' ').trim().slice(0, max) : ''
    return raw || DEFAULT_YUANBAO[key]
  }
  const list = (key: 'stocks' | 'tools') =>
    Array.isArray(v[key]) ? (v[key] as unknown[]) : DEFAULT_YUANBAO[key]
  const stocks = [
    ...new Set(
      list('stocks')
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => YUANBAO_STOCK.test(s)),
    ),
  ].slice(0, 3)
  const tools = [
    ...new Set(
      list('tools')
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.replace(/\s+/g, ' ').trim().slice(0, 40))
        .filter(Boolean),
    ),
  ].slice(0, 4)
  const limit =
    typeof v.dailyRequestLimit === 'number' && Number.isFinite(v.dailyRequestLimit)
      ? Math.max(1, Math.min(200, Math.round(v.dailyRequestLimit)))
      : DEFAULT_YUANBAO.dailyRequestLimit
  return {
    enabled: bool('enabled'),
    weatherEnabled: bool('weatherEnabled'),
    city: text('city', 20),
    goldEnabled: bool('goldEnabled'),
    goldBrand: bool('goldBrand'),
    stocksEnabled: bool('stocksEnabled'),
    stocks: Array.isArray(v.stocks) ? stocks : [...DEFAULT_YUANBAO.stocks],
    toolsEnabled: bool('toolsEnabled'),
    tools: Array.isArray(v.tools) ? tools : [...DEFAULT_YUANBAO.tools],
    holidayEnabled: bool('holidayEnabled'),
    newsEnabled: bool('newsEnabled'),
    newsTopic: text('newsTopic', 20),
    dailyRequestLimit: limit,
  }
}

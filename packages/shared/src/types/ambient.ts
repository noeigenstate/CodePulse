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
}
export interface AmbientCard {
  id: string
  kind: 'x' | 'meme' | 'concept' | 'prompt' | 'note' | 'image' | 'news' | 'pet'
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
  /** Screen layout for a bitmap card; only pet cards use `'pet'` (larger picture, 20px line). */
  layout?: 'pet'
  /** Pet cards only: which pet this is and the mood it was drawn for. */
  pet?: { id: PetId; mood: PetMood }
}
export interface DeviceAmbientCard {
  /** Explicit temporary display may cover review notices; action/fault still win. */
  manual?: boolean
  id: string
  source: string
  text: string
  imageHex?: string
  /** Optional; devices drop it (and show black only) if it is invalid. */
  red?: AmbientRedPlane
  /** Optional, only with `imageHex`; firmware older than 0.0.28 ignores it. */
  layout?: 'pet'
}
export interface AmbientSnapshot {
  config: AmbientConfig
  hasKey: boolean
  collecting: boolean
  lastCheckedAt: number
  nextCheckAt: number
  sourceStatus: { x: string; meme: string; news?: string }
  cards: AmbientCard[]
  activeId: string | null
  shownToday: number
  xRequestsToday: number
  pausedReason: string
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
  }
}

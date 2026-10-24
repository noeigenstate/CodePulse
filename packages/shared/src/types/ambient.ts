/** Optional, low-priority desk content. Credentials never cross back to the renderer. */
export interface AmbientConfig {
  version: 1
  enabled: boolean
  xEnabled: boolean
  memeEnabled: boolean
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
  kind: 'x' | 'meme'
  source: string
  text: string
  url: string
  publishedAt: number
  expiresAt: number
  score: number
  imageUrl?: string
  /** 384 x 208, row-major, MSB first; 1 = black. No external image requests on device. */
  imageHex?: string
}
export interface DeviceAmbientCard {
  id: string
  source: string
  text: string
  imageHex?: string
}
export interface AmbientSnapshot {
  config: AmbientConfig
  hasKey: boolean
  collecting: boolean
  lastCheckedAt: number
  nextCheckAt: number
  sourceStatus: { x: string; meme: string }
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

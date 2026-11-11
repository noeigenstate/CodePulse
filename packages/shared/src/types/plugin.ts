import { AMBIENT_RED_MAX_BYTES, type AmbientRedPlane } from './ambient.js'
import { normalizeDeviceLife, type DeviceLife } from './life.js'

/**
 * Plugin platform contract (v1), shared by `server/`, its store page and the desktop.
 * A plugin is a cloud-side card generator: the platform produces cards for each client's
 * installed plugins and the desktop only pulls them, validates them again and adds them to
 * the desk-content pool. No plugin code runs on the desktop or the device.
 */
export const PLUGIN_API_VERSION = 1
/** Lower-case, 3–40 chars, dot or dash separated, e.g. `codepulse.hn-digest`. */
export const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/
/** The id prefix reserved for plugins the platform itself publishes. */
export const OFFICIAL_PLUGIN_PREFIX = 'codepulse.'
export const isPluginId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length >= 3 &&
  value.length <= 40 &&
  PLUGIN_ID_PATTERN.test(value)
/** builtin: first-party generator in server code; pack: uploaded static cards the platform
 * rotates; webhook: a developer HTTPS endpoint the platform calls with the user's settings. */
export type PluginKind = 'builtin' | 'pack' | 'webhook'
export type PluginReviewState = 'draft' | 'pending' | 'approved' | 'rejected'

export type PluginSetting =
  | { key: string; label: string; type: 'text'; default: string; maxLength: number }
  | { key: string; label: string; type: 'number'; default: number; min: number; max: number }
  | { key: string; label: string; type: 'boolean'; default: boolean }
  | {
      key: string
      label: string
      type: 'select'
      default: string
      options: { value: string; label: string }[]
    }
export type PluginSettingValues = Record<string, string | number | boolean>

/** What a developer submits for one version; `kind`-specific payload travels beside it. */
export interface PluginManifest {
  id: string
  /** Semver `MAJOR.MINOR.PATCH`. */
  version: string
  name: string
  /** One line for the list, at most 60 chars. */
  summary: string
  description: string
  kind: PluginKind
  /** How often the platform regenerates cards for one installation; 15–1440. */
  refreshMinutes: number
  settings: PluginSetting[]
}

/** Catalog entry as the store lists it: only the approved version is public. */
export interface PluginListing {
  id: string
  name: string
  summary: string
  description: string
  kind: PluginKind
  version: string
  developer: string
  installs: number
  settings: PluginSetting[]
  updatedAt: number
  /**
   * Path of the developer's logo on the platform, e.g. `/api/v1/plugins/<id>/logo?v=<hash>`;
   * null shows the text glyph. Callers prefix the platform origin.
   */
  logoUrl: string | null
}

export interface PluginInstall {
  pluginId: string
  enabled: boolean
  settings: PluginSettingValues
  installedAt: number
}

/** One generation status per install, shared by the store's 已安装 tab and the desktop. */
export interface PluginInstallStatus {
  generatedAt: number | null
  error: string
}

/** `GET /api/v1/client/installs` (client token): what the desktop lists natively. */
export interface ClientInstalledPlugin extends PluginInstall {
  status: PluginInstallStatus
  /** Null when the plugin was withdrawn from the catalog after it was installed. */
  plugin: PluginListing | null
}

/** Developer logo upload: `PUT /api/v1/dev/plugins/:id/logo` with base64 `data`. */
export const PLUGIN_LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type PluginLogoType = (typeof PLUGIN_LOGO_TYPES)[number]
export const PLUGIN_LOGO_MAX_BYTES = 200 * 1024
/** Logos are square, between these sizes in pixels. */
export const PLUGIN_LOGO_MIN_PX = 64
export const PLUGIN_LOGO_MAX_PX = 1024

/**
 * One generated card. The same capacities as the device card; the desktop turns it into an
 * `AmbientCard` of kind `plugin` with id `plugin:<pluginId>:<id>`.
 */
export interface PluginCard {
  /** Stable within the plugin, `[A-Za-z0-9._:-]{1,64}`; a changed card needs a new id. */
  id: string
  /** Header line, at most 40 chars. */
  source: string
  /** Body text and the fallback for older firmware, at most 400 chars. */
  text: string
  /** Up to six checklist rows. */
  items?: { title: string; meta: string; overdue: boolean }[]
  /** Structured life layout (weather, stock, Hacker News …). */
  life?: DeviceLife
  /** 384 × 208 1-bit bitmap, 19968 hex chars, row-major, MSB first, 1 = black. */
  imageHex?: string
  /** Red plane over `imageHex`; see `AmbientRedPlane`. */
  red?: AmbientRedPlane
  /** Epoch ms; the platform caps it at 24 h from generation. */
  expiresAt: number
}

/** `GET /api/v1/client/cards` response. */
export interface PluginFeed {
  v: 1
  generatedAt: number
  /** The desktop should not poll again before this (epoch ms). */
  nextPollAt: number
  cards: (PluginCard & { pluginId: string })[]
  /** Per-plugin generation errors, shown in the store's "已安装" list. */
  errors: Record<string, string>
}

/** Messages the store page posts to the desktop renderer that embeds it. */
export type PluginStoreMessage = { type: 'codepulse:installs-changed' }

export const PLUGIN_IMAGE_HEX_LENGTH = (384 * 208) / 4
const CARD_ID = /^[A-Za-z0-9._:-]{1,64}$/
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u
const MAX_EXPIRY_MS = 24 * 3600000
/** At most `max` characters, no control or bidi-override characters; `required` also rejects blank. */
export const isPlainText = (v: unknown, max: number, required = false): v is string =>
  typeof v === 'string' &&
  Array.from(v).length <= max &&
  (!required || v.trim().length > 0) &&
  !CONTROL.test(v)
const hex = (v: unknown, length: number): v is string =>
  typeof v === 'string' && v.length === length && /^[0-9a-f]*$/i.test(v)

function redPlane(v: unknown): AmbientRedPlane | undefined {
  if (!v || typeof v !== 'object') return undefined
  const { x, y, w, h, hex: plane } = v as Record<string, unknown>
  const int = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0
  if (!int(x) || !int(y) || !int(w) || !int(h) || w === 0 || h === 0) return undefined
  if (x % 8 || w % 8 || x + w > 384 || y + h > 208 || (w * h) / 8 > AMBIENT_RED_MAX_BYTES)
    return undefined
  return hex(plane, (w * h) / 4) ? { x, y, w, h, hex: plane } : undefined
}

/**
 * Strict validation of an untrusted card; returns undefined for anything the device could not
 * show. `now` bounds the expiry. Both the platform (before caching) and the desktop (after
 * download) call it, so a card that passes here is safe to hand to the device projection.
 */
export function normalizePluginCard(value: unknown, now: number): PluginCard | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const c = value as Record<string, unknown>
  if (typeof c.id !== 'string' || !CARD_ID.test(c.id)) return undefined
  if (!isPlainText(c.source, 40, true) || !isPlainText(c.text, 400, true)) return undefined
  if (typeof c.expiresAt !== 'number' || !Number.isFinite(c.expiresAt) || c.expiresAt <= now)
    return undefined
  const card: PluginCard = {
    id: c.id,
    source: c.source,
    text: c.text,
    expiresAt: Math.min(c.expiresAt, now + MAX_EXPIRY_MS),
  }
  if (c.items !== undefined) {
    if (!Array.isArray(c.items) || c.items.length > 6) return undefined
    const items = c.items.map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>
      return isPlainText(i.title, 80, true) &&
        isPlainText(i.meta, 24) &&
        typeof i.overdue === 'boolean'
        ? { title: i.title, meta: i.meta, overdue: i.overdue }
        : undefined
    })
    if (items.some((i) => !i)) return undefined
    card.items = items as PluginCard['items']
  }
  if (c.life !== undefined) {
    const life = normalizeDeviceLife(c.life)
    if (!life) return undefined
    card.life = life
  }
  if (c.imageHex !== undefined) {
    if (!hex(c.imageHex, PLUGIN_IMAGE_HEX_LENGTH)) return undefined
    card.imageHex = c.imageHex.toLowerCase()
  }
  if (c.red !== undefined) {
    const red = card.imageHex ? redPlane(c.red) : undefined
    if (!red) return undefined
    card.red = red
  }
  // One presentation per card: a bitmap, a life layout or a checklist, never two.
  if ([card.items, card.life, card.imageHex].filter(Boolean).length > 1) return undefined
  return card
}

/** Fills in defaults and drops unknown or out-of-range values. */
export function normalizePluginSettings(
  schema: PluginSetting[],
  value: unknown,
): PluginSettingValues {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return Object.fromEntries(
    schema.map((s) => {
      const v = input[s.key]
      switch (s.type) {
        case 'text':
          return [s.key, isPlainText(v, s.maxLength) ? v : s.default]
        case 'number':
          return [
            s.key,
            typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max ? v : s.default,
          ]
        case 'boolean':
          return [s.key, typeof v === 'boolean' ? v : s.default]
        case 'select':
          return [s.key, s.options.some((o) => o.value === v) ? (v as string) : s.default]
      }
    }),
  )
}

/**
 * Text icon for a plugin without a logo, the same on the store page and the desktop:
 * the first two capitals of a Latin name (Hacker News → HN), otherwise the last Han
 * character (每日古诗 → 诗, which tells 每日一词 apart), otherwise the first character.
 */
export function pluginGlyph(name: string): string {
  const capitals = name.match(/[A-Z]/g)
  if (capitals && capitals.length > 1) return capitals.slice(0, 2).join('')
  const han = name.match(/\p{Script=Han}/gu)
  return han ? han[han.length - 1]! : (Array.from(name)[0] ?? '')
}

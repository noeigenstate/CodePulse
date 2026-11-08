import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  normalizePluginSettings,
  normalizePluginCard,
  type PluginCard,
  type PluginSettingValues,
} from '@codepulse/shared'
import { liveVersion, manifestOf, type Version } from '../db.js'
import { hnDigest } from './builtin/hn-digest.js'
import { packCard } from './pack.js'
import { deadline, webhookCards, type ResolveHost, type WebhookTransport } from './webhook.js'

export interface GenerationOptions {
  timeZone: string
  now: () => number
  fetch: typeof fetch
  resolveHost: ResolveHost
  allowHttpLoopbackWebhooks: boolean
  webhookTransport: WebhookTransport
}
export interface GenerationResult {
  cards: PluginCard[]
  error: string
  generatedAt: number | null
  expiresAt: number
}
interface CacheRow {
  cards_json: string
  error: string
  generated_at: number | null
  expires_at: number
}

export function settingsHash(settings: PluginSettingValues): string {
  const ordered = Object.fromEntries(
    Object.entries(settings).sort(([a], [b]) => a.localeCompare(b)),
  )
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex')
}

export class Generator {
  private pending = new Map<string, Promise<GenerationResult>>()
  constructor(
    private db: Database.Database,
    private options: GenerationOptions,
  ) {}

  async generate(version: Version, input: unknown): Promise<PluginCard[]> {
    const manifest = manifestOf(version)
    const settings = normalizePluginSettings(manifest.settings, input)
    const payload = JSON.parse(version.payload_json) as {
      cards?: Record<string, unknown>[]
      endpoint?: string
    }
    const now = this.options.now()
    const cards = await deadline(async (signal) => {
      switch (manifest.kind) {
        case 'pack':
          return packCard(payload.cards!, now, this.options.timeZone)
        case 'builtin':
          if (manifest.id !== 'codepulse.hn-digest') throw new Error('内置插件不存在')
          return hnDigest(settings, now, this.options.fetch, signal, this.options.timeZone)
        case 'webhook':
          return webhookCards({
            manifest,
            settings,
            now,
            signal,
            endpoint: payload.endpoint!,
            secret: version.webhook_secret,
            resolve: this.options.resolveHost,
            allowHttpLoopback: this.options.allowHttpLoopbackWebhooks,
            transport: this.options.webhookTransport,
          })
      }
    })
    const validated = cards.map((card) => normalizePluginCard(card, this.options.now()))
    if (validated.some((card) => !card)) throw new Error('生成的卡片已失效')
    return validated as PluginCard[]
  }

  status(version: Version, input: unknown): GenerationResult {
    const settings = normalizePluginSettings(manifestOf(version).settings, input)
    const row = this.db
      .prepare(
        'SELECT * FROM card_cache WHERE plugin_id = ? AND version_id = ? AND settings_hash = ?',
      )
      .get(version.plugin_id, version.id, settingsHash(settings)) as CacheRow | undefined
    return {
      cards: row
        ? (JSON.parse(row.cards_json) as PluginCard[]).filter(
            (c) => c.expiresAt > this.options.now(),
          )
        : [],
      error: row?.error ?? '',
      generatedAt: row?.generated_at ?? null,
      expiresAt: row?.expires_at ?? 0,
    }
  }

  async cached(version: Version, input: unknown): Promise<GenerationResult> {
    const manifest = manifestOf(version)
    const settings = normalizePluginSettings(manifest.settings, input)
    const previous = this.status(version, settings)
    if (previous.expiresAt > this.options.now()) return previous
    const hash = settingsHash(settings)
    const key = `${version.id}:${hash}`
    const existing = this.pending.get(key)
    if (existing) return existing
    const operation = this.refresh(version, settings, hash, previous)
    this.pending.set(key, operation)
    try {
      return await operation
    } finally {
      this.pending.delete(key)
    }
  }

  private async refresh(
    version: Version,
    settings: PluginSettingValues,
    hash: string,
    previous: GenerationResult,
  ): Promise<GenerationResult> {
    let result: GenerationResult
    try {
      const cards = await this.generate(version, settings)
      const now = this.options.now()
      result = {
        cards,
        error: '',
        generatedAt: now,
        expiresAt: Math.min(
          now + manifestOf(version).refreshMinutes * 60000,
          ...cards.map((c) => c.expiresAt),
        ),
      }
    } catch (error) {
      // Back off after errors without extending the cards' own expiry or losing the last success time.
      const cards = previous.cards.filter((c) => c.expiresAt > this.options.now())
      result = {
        ...previous,
        cards,
        error: generationError(error),
        expiresAt: Math.min(this.options.now() + 60000, ...cards.map((c) => c.expiresAt)),
      }
    }
    this.db.transaction(() => {
      this.prune(version, hash)
      // A review can advance the live version while a webhook is in flight.
      if (liveVersion(this.db, version.plugin_id)?.id !== version.id) return
      this.db
        .prepare(
          `INSERT INTO card_cache VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(plugin_id, version_id, settings_hash) DO UPDATE SET
      cards_json=excluded.cards_json, error=excluded.error, generated_at=excluded.generated_at, expires_at=excluded.expires_at`,
        )
        .run(
          version.plugin_id,
          version.id,
          hash,
          JSON.stringify(result.cards),
          result.error,
          result.generatedAt,
          result.expiresAt,
        )
    })()
    return result
  }

  private prune(version: Version, hash: string): void {
    this.db
      .prepare('DELETE FROM card_cache WHERE expires_at < ?')
      .run(this.options.now() - 86400000)
    const live = liveVersion(this.db, version.plugin_id)
    if (!live) return
    const manifest = manifestOf(live)
    const hashes = new Set([settingsHash(normalizePluginSettings(manifest.settings, {}))])
    if (version.id === live.id) hashes.add(hash)
    const installs = this.db
      .prepare('SELECT settings_json FROM installs WHERE plugin_id = ?')
      .all(version.plugin_id) as { settings_json: string }[]
    // Cache keys are shared: changing one install must not evict another install's settings.
    for (const install of installs) {
      hashes.add(
        settingsHash(normalizePluginSettings(manifest.settings, JSON.parse(install.settings_json))),
      )
    }
    const placeholders = Array.from(hashes, () => '?').join(',')
    this.db
      .prepare(
        `DELETE FROM card_cache WHERE plugin_id = ?
      AND (version_id != ? OR settings_hash NOT IN (${placeholders}))`,
      )
      .run(version.plugin_id, live.id, ...hashes)
  }
}

export function generationError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Network libraries can expose endpoint details; only return our short Chinese errors.
  return /^[\u4e00-\u9fff]/u.test(message)
    ? Array.from(message).slice(0, 100).join('')
    : '生成失败，请稍后再试'
}

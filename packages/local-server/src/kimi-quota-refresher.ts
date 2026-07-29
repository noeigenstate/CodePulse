/**
 * Hook-driven Kimi account quota refresher.
 *
 * Production runs session sync in low-I/O mode (boot + resume + explicit
 * refresh), and `syncKimi` bails out entirely when the CLI is not running at
 * that moment. Kimi hooks carry context usage but never account quota, so when
 * CodePulse starts before the Kimi CLI (the common autostart-at-login order)
 * the KIMI usage meter could stay missing for the whole app lifetime. This
 * refresher mirrors {@link QuotaRefreshWatcher}: any live Kimi hook event
 * re-arms a throttled account-quota fetch and folds the result into the
 * session that triggered it.
 *
 * @module local-server/kimi-quota-refresher
 */
import type { AgentEvent } from '@codepulse/shared'
import type { StatusHub } from '@codepulse/core'
import { resolveKimiAccountQuota, type KimiQuotaSnapshot } from './kimi-quota.js'

/** Matches the session-sync account cadence; the endpoint is account-level. */
const DEFAULT_MIN_INTERVAL_MS = 30_000

export interface KimiQuotaRefresherOptions {
  hub: StatusHub
  now?: () => number
  /** Minimum delay between two account-quota fetches (tests may shrink it). */
  minIntervalMs?: number
  /** Test seam for the managed-usage endpoint resolver. */
  resolveQuota?: () => Promise<KimiQuotaSnapshot | undefined>
}

interface RefreshTarget {
  sessionId?: string
  cwd?: string
}

export class KimiQuotaRefresher {
  private readonly hub: StatusHub
  private readonly now: () => number
  private readonly minIntervalMs: number
  private readonly resolveQuota: () => Promise<KimiQuotaSnapshot | undefined>
  private lastRefreshAt = 0
  private trailing?: NodeJS.Timeout
  private inflight?: Promise<void>

  constructor(options: KimiQuotaRefresherOptions) {
    this.hub = options.hub
    this.now = options.now ?? Date.now
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
    this.resolveQuota = options.resolveQuota ?? (() => resolveKimiAccountQuota())
  }

  observe(event: AgentEvent): void {
    if (event.source !== 'kimi') return
    // Refresh events are outputs of this refresher. Feeding them back in would
    // re-arm the throttle on every publish.
    if (event.internal?.quotaRefresh) return

    const target: RefreshTarget = {
      sessionId: event.externalSessionId,
      cwd: event.workspacePath ?? event.cwd,
    }
    const elapsed = this.now() - this.lastRefreshAt
    if (elapsed >= this.minIntervalMs) {
      void this.refresh(target)
      return
    }
    if (this.trailing) return
    this.trailing = setTimeout(() => {
      this.trailing = undefined
      void this.refresh(target)
    }, this.minIntervalMs - elapsed)
    this.trailing.unref?.()
  }

  stop(): void {
    if (this.trailing) clearTimeout(this.trailing)
    this.trailing = undefined
  }

  private refresh(target: RefreshTarget): Promise<void> {
    if (this.inflight) return this.inflight
    this.lastRefreshAt = this.now()
    this.inflight = (async () => {
      const quota = await this.resolveQuota().catch(() => undefined)
      if (!quota) return
      this.hub.observeQuota({
        id: `kimi-quota-refresh:${this.now()}`,
        source: 'kimi',
        eventType: 'token_snapshot',
        ...(target.sessionId ? { externalSessionId: target.sessionId } : {}),
        ...(target.cwd ? { cwd: target.cwd, workspacePath: target.cwd } : {}),
        token: {
          rateLimits: quota.rateLimits,
          rateLimitId: 'kimi-code',
          rateLimitName: 'Kimi Code',
          accuracy: 'estimated',
        },
        timestamp: this.now(),
        internal: { quotaRefresh: true },
      })
    })().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }
}

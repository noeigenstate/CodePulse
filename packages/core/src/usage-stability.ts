import {
  type AgentEvent,
  type AgentRuntimeState,
  type AgentType,
  type TokenPayload,
  type TokenRateLimitWindow,
} from '@codepulse/shared'

/** Pending sequence of lower readings for one rolling quota window. */
interface PendingLowerQuota {
  /** Number of distinct, compatible lower observations. */
  count: number
  /** Most recent physical/API sample counted in this sequence. */
  lastSampleId: string
  /** Most recent lower window, used to validate period and linear growth. */
  lastWindow: TokenRateLimitWindow
}

/** Accepted and pending state for one five-hour or weekly quota window. */
interface StableQuotaWindow {
  /** Latest value allowed to reach runtime and renderer state. */
  accepted?: TokenRateLimitWindow
  /** Lower value awaiting five-read confirmation. */
  pendingLower?: PendingLowerQuota
}

/** Independent stable windows belonging to one CLI account quota family. */
interface StableQuotaFamily {
  /** Five-hour rolling quota state. */
  fiveHour: StableQuotaWindow
  /** Seven-day rolling quota state. */
  sevenDay: StableQuotaWindow
}

/** Number of consecutive lower observations required to confirm an official reset. */
const LOWER_QUOTA_CONFIRMATION_READS = 5
/** Maximum reset timestamp drift treated as one quota period. */
const QUOTA_RESET_TOLERANCE_MS = 60_000
/** Rolling CLI quota windows farther away than this are treated as malformed metadata. */
const MAX_REASONABLE_RESET_AHEAD_MS = 10 * 24 * 60 * 60_000

/**
 * Stabilizes account-wide quota observations across all runtime sessions.
 *
 * CLI account quota is copied into multiple project events and can be read from
 * several stale session files. This registry keeps one accepted value per CLI,
 * quota family, and window, then projects that value back onto every session.
 */
export class UsageStabilityRegistry {
  /** Accepted and pending quota state keyed by CLI and native bucket family. */
  private readonly quotaFamilies = new Map<string, StableQuotaFamily>()

  /**
   * Replaces raw quota windows with the globally accepted account values.
   *
   * A higher reading is accepted immediately. A lower reading remains pending
   * until five distinct observations from the same candidate period arrive.
   * Missing quota fields are left untouched and never clear accepted values.
   *
   * @param event Incoming normalized agent event.
   * @returns Event whose quota fields contain only accepted stable values.
   */
  stabilizeEvent(event: AgentEvent): AgentEvent {
    if (!event.token || !hasQuotaPayload(event.token)) return event

    const sampleId = event.internal?.usageSampleId?.trim() || event.id
    const token = this.observeToken(event.source, event.token, sampleId)
    return token === event.token ? event : { ...event, token }
  }

  /**
   * Applies the latest accepted account quota to one runtime session.
   *
   * @param agent Runtime state that may contain top-level or named quota buckets.
   * @returns Runtime state with globally consistent quota values.
   */
  projectAgent(agent: AgentRuntimeState): AgentRuntimeState {
    if (!agent.token || !hasQuotaPayload(agent.token)) return agent
    const token = this.projectToken(agent.agentType, agent.token)
    return token === agent.token ? agent : { ...agent, token }
  }

  /**
   * Observes all quota families carried by one token payload.
   *
   * @param agentType CLI family that produced the payload.
   * @param token Raw token and quota payload.
   * @param sampleId Stable identifier shared by fan-out events from one read.
   * @returns Token payload containing accepted quota windows.
   */
  private observeToken(agentType: AgentType, token: TokenPayload, sampleId: string): TokenPayload {
    let changed = false
    let rateLimits = token.rateLimits
    if (rateLimits) {
      const familyKey = quotaFamilyKey(agentType, token.rateLimitId, token.rateLimitName)
      const stable = this.observeRateLimits(familyKey, rateLimits, sampleId)
      if (!sameRateLimits(rateLimits, stable)) {
        rateLimits = stable
        changed = true
      }
    }

    let quotaBuckets = token.quotaBuckets
    if (quotaBuckets) {
      const nextBuckets = { ...quotaBuckets }
      for (const [bucketKey, bucket] of Object.entries(quotaBuckets)) {
        if (!bucket.rateLimits) continue
        const familyKey = quotaFamilyKey(
          agentType,
          bucket.rateLimitId ?? bucketKey,
          bucket.rateLimitName,
        )
        const stable = this.observeRateLimits(familyKey, bucket.rateLimits, sampleId)
        if (sameRateLimits(bucket.rateLimits, stable)) continue
        nextBuckets[bucketKey] = { ...bucket, rateLimits: stable }
        changed = true
      }
      if (changed) quotaBuckets = nextBuckets
    }

    if (!changed) return token
    return {
      ...token,
      ...(rateLimits ? { rateLimits } : {}),
      ...(quotaBuckets ? { quotaBuckets } : {}),
    }
  }

  /**
   * Projects accepted quota values without recording another observation.
   *
   * @param agentType CLI family that owns the token.
   * @param token Runtime token payload to update.
   * @returns Original token when no projection changed, otherwise a new payload.
   */
  private projectToken(agentType: AgentType, token: TokenPayload): TokenPayload {
    let changed = false
    let rateLimits = token.rateLimits
    if (rateLimits) {
      const familyKey = quotaFamilyKey(agentType, token.rateLimitId, token.rateLimitName)
      const stable = this.acceptedRateLimits(familyKey)
      if (stable && !sameRateLimits(rateLimits, stable)) {
        rateLimits = stable
        changed = true
      }
    }

    let quotaBuckets = token.quotaBuckets
    if (quotaBuckets) {
      const nextBuckets = { ...quotaBuckets }
      for (const [bucketKey, bucket] of Object.entries(quotaBuckets)) {
        if (!bucket.rateLimits) continue
        const familyKey = quotaFamilyKey(
          agentType,
          bucket.rateLimitId ?? bucketKey,
          bucket.rateLimitName,
        )
        const stable = this.acceptedRateLimits(familyKey)
        if (!stable || sameRateLimits(bucket.rateLimits, stable)) continue
        nextBuckets[bucketKey] = { ...bucket, rateLimits: stable }
        changed = true
      }
      if (changed) quotaBuckets = nextBuckets
    }

    if (!changed) return token
    return {
      ...token,
      ...(rateLimits ? { rateLimits } : {}),
      ...(quotaBuckets ? { quotaBuckets } : {}),
    }
  }

  /**
   * Observes both rolling windows for one account quota family.
   *
   * @param familyKey Stable CLI and bucket identity.
   * @param incoming Incoming quota windows.
   * @param sampleId Identifier for one physical/API observation.
   * @returns Currently accepted windows for this family.
   */
  private observeRateLimits(
    familyKey: string,
    incoming: NonNullable<TokenPayload['rateLimits']>,
    sampleId: string,
  ): NonNullable<TokenPayload['rateLimits']> {
    const family = this.getQuotaFamily(familyKey)
    for (const windowKey of ['fiveHour', 'sevenDay'] as const) {
      this.observeQuotaWindow(family[windowKey], incoming[windowKey], sampleId)
    }
    return acceptedFamilyRateLimits(family)
  }

  /**
   * Applies one observation to a stable rolling quota window.
   *
   * @param state Mutable stability state for one rolling window.
   * @param incoming Newly read quota window, if present.
   * @param sampleId Identifier used to deduplicate project fan-out.
   */
  private observeQuotaWindow(
    state: StableQuotaWindow,
    incoming: TokenRateLimitWindow | undefined,
    sampleId: string,
  ): void {
    const candidate = sanitizeQuotaWindow(incoming)
    if (!candidate) return
    if (!state.accepted) {
      state.accepted = candidate
      state.pendingLower = undefined
      return
    }

    const resetOrder = compareQuotaReset(candidate.resetsAt, state.accepted.resetsAt)
    if (resetOrder !== undefined && resetOrder < 0) return

    const acceptedUsage = finitePercent(state.accepted.usedPercent)
    const incomingUsage = finitePercent(candidate.usedPercent)
    if (incomingUsage === undefined) {
      state.accepted = mergeQuotaMetadata(state.accepted, candidate, resetOrder)
      return
    }
    if (acceptedUsage === undefined || incomingUsage > acceptedUsage) {
      state.accepted = mergeAcceptedQuota(state.accepted, candidate, incomingUsage, resetOrder)
      state.pendingLower = undefined
      return
    }
    if (incomingUsage === acceptedUsage) {
      state.accepted = mergeAcceptedQuota(state.accepted, candidate, incomingUsage, resetOrder)
      state.pendingLower = undefined
      return
    }

    const pending = state.pendingLower
    if (pending?.lastSampleId === sampleId) return
    const continuesPeriod =
      pending !== undefined && sameCandidateQuotaPeriod(pending.lastWindow, candidate)
    const previousPendingUsage = finitePercent(pending?.lastWindow.usedPercent)
    const continuesGrowth =
      previousPendingUsage === undefined || incomingUsage >= previousPendingUsage
    const count = continuesPeriod && continuesGrowth ? pending.count + 1 : 1

    if (count >= LOWER_QUOTA_CONFIRMATION_READS) {
      state.accepted = mergeAcceptedQuota(state.accepted, candidate, incomingUsage, resetOrder)
      state.pendingLower = undefined
      return
    }
    state.pendingLower = {
      count,
      lastSampleId: sampleId,
      lastWindow: candidate,
    }
  }

  /**
   * Returns or creates state for one CLI quota family.
   *
   * @param familyKey Stable CLI and bucket identity.
   * @returns Mutable family state.
   */
  private getQuotaFamily(familyKey: string): StableQuotaFamily {
    const current = this.quotaFamilies.get(familyKey)
    if (current) return current
    const created: StableQuotaFamily = { fiveHour: {}, sevenDay: {} }
    this.quotaFamilies.set(familyKey, created)
    return created
  }

  /**
   * Reads accepted windows for one family without changing counters.
   *
   * @param familyKey Stable CLI and bucket identity.
   * @returns Accepted quota windows, or `undefined` before any usable reading.
   */
  private acceptedRateLimits(
    familyKey: string,
  ): NonNullable<TokenPayload['rateLimits']> | undefined {
    const family = this.quotaFamilies.get(familyKey)
    if (!family || (!family.fiveHour.accepted && !family.sevenDay.accepted)) return undefined
    return acceptedFamilyRateLimits(family)
  }
}

/**
 * Builds the visible accepted rate-limit payload for one family.
 *
 * @param family Stability state for one account quota family.
 * @returns Accepted five-hour and weekly windows.
 */
function acceptedFamilyRateLimits(
  family: StableQuotaFamily,
): NonNullable<TokenPayload['rateLimits']> {
  return {
    fiveHour: family.fiveHour.accepted,
    sevenDay: family.sevenDay.accepted,
  }
}

/**
 * Reports whether a token contains account quota in any supported shape.
 *
 * @param token Token payload to inspect.
 * @returns Whether top-level or named quota windows are present.
 */
function hasQuotaPayload(token: TokenPayload): boolean {
  return Boolean(
    token.rateLimits || Object.values(token.quotaBuckets ?? {}).some((bucket) => bucket.rateLimits),
  )
}

/**
 * Creates a stable account quota family key.
 *
 * Codex default and Spark limits are distinct even when a top-level snapshot
 * omits its identifier. Other CLIs retain their native bucket identifier.
 *
 * @param agentType CLI family that owns the account quota.
 * @param rateLimitId Native quota bucket identifier.
 * @param rateLimitName Native quota bucket display name.
 * @returns Stable in-memory registry key.
 */
function quotaFamilyKey(
  agentType: AgentType,
  rateLimitId: string | undefined,
  rateLimitName: string | undefined,
): string {
  const identity = normalizeQuotaIdentity(rateLimitId || rateLimitName)
  if (agentType === 'codex') {
    const descriptor = `${rateLimitId ?? ''} ${rateLimitName ?? ''}`.toLowerCase()
    const family =
      descriptor.includes('spark') || descriptor.includes('bengalfox') ? 'spark' : 'main'
    return `${agentType}\0${family}`
  }
  return `${agentType}\0${identity || 'default'}`
}

/**
 * Normalizes a quota identity for use as a registry key.
 *
 * @param value Native bucket identifier or name.
 * @returns Lowercase trimmed identity with internal whitespace collapsed.
 */
function normalizeQuotaIdentity(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

/**
 * Sanitizes a quota window before it enters stability state.
 *
 * @param window Raw quota window.
 * @returns Usable copy, or `undefined` when it contains no usable fields.
 */
function sanitizeQuotaWindow(
  window: TokenRateLimitWindow | undefined,
): TokenRateLimitWindow | undefined {
  if (!window) return undefined
  const usedPercent = finitePercent(window.usedPercent)
  const resetsAt = plausibleResetAt(window.resetsAt)
  const windowMinutes = finitePositive(window.windowMinutes)
  if (usedPercent === undefined && resetsAt === undefined && windowMinutes === undefined) {
    return undefined
  }
  return {
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  }
}

/**
 * Returns a finite quota percentage clamped to its valid display range.
 *
 * @param value Candidate percentage.
 * @returns Normalized percentage, or `undefined` for invalid input.
 */
function finitePercent(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(100, value))
}

/**
 * Returns a finite positive number.
 *
 * @param value Candidate numeric metadata.
 * @returns Original value when finite and positive.
 */
function finitePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Rejects reset timestamps that are implausibly far beyond rolling CLI windows.
 *
 * @param value Reset timestamp in epoch seconds or milliseconds.
 * @returns Original timestamp when plausible.
 */
function plausibleResetAt(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const resetMs = normalizeResetAtMs(value)
  if (resetMs - Date.now() > MAX_REASONABLE_RESET_AHEAD_MS) return undefined
  return value
}

/**
 * Compares incoming and accepted quota reset periods.
 *
 * @param incoming Incoming reset timestamp.
 * @param accepted Accepted reset timestamp.
 * @returns Signed ordering, zero inside tolerance, or `undefined` when unknown.
 */
function compareQuotaReset(
  incoming: number | undefined,
  accepted: number | undefined,
): number | undefined {
  if (incoming === undefined || accepted === undefined) return undefined
  const difference = normalizeResetAtMs(incoming) - normalizeResetAtMs(accepted)
  return Math.abs(difference) <= QUOTA_RESET_TOLERANCE_MS ? 0 : difference
}

/**
 * Checks whether two lower readings belong to one candidate quota period.
 *
 * @param previous Previous pending lower reading.
 * @param incoming Incoming lower reading.
 * @returns Whether both readings may extend one confirmation streak.
 */
function sameCandidateQuotaPeriod(
  previous: TokenRateLimitWindow,
  incoming: TokenRateLimitWindow,
): boolean {
  const resetOrder = compareQuotaReset(incoming.resetsAt, previous.resetsAt)
  if (resetOrder !== undefined && resetOrder !== 0) return false
  if (
    previous.windowMinutes !== undefined &&
    incoming.windowMinutes !== undefined &&
    previous.windowMinutes !== incoming.windowMinutes
  ) {
    return false
  }
  return true
}

/**
 * Merges an accepted usage reading with its latest trustworthy metadata.
 *
 * @param accepted Previously accepted window.
 * @param incoming Newly accepted window.
 * @param usedPercent Newly accepted usage percentage.
 * @param resetOrder Ordering of incoming and accepted reset periods.
 * @returns Updated accepted window.
 */
function mergeAcceptedQuota(
  accepted: TokenRateLimitWindow,
  incoming: TokenRateLimitWindow,
  usedPercent: number,
  resetOrder: number | undefined,
): TokenRateLimitWindow {
  return {
    ...accepted,
    ...incoming,
    usedPercent,
    ...(resetOrder !== undefined && resetOrder > 0
      ? { resetsAt: incoming.resetsAt }
      : accepted.resetsAt !== undefined
        ? { resetsAt: accepted.resetsAt }
        : {}),
  }
}

/**
 * Updates metadata-only observations without moving usage backwards.
 *
 * @param accepted Previously accepted window.
 * @param incoming Metadata-only incoming window.
 * @param resetOrder Ordering of incoming and accepted reset periods.
 * @returns Accepted usage with safe metadata updates.
 */
function mergeQuotaMetadata(
  accepted: TokenRateLimitWindow,
  incoming: TokenRateLimitWindow,
  resetOrder: number | undefined,
): TokenRateLimitWindow {
  if (resetOrder !== undefined && resetOrder > 0) return { ...accepted, ...incoming }
  return {
    ...accepted,
    ...(accepted.resetsAt === undefined && incoming.resetsAt !== undefined
      ? { resetsAt: incoming.resetsAt }
      : {}),
    ...(incoming.windowMinutes !== undefined ? { windowMinutes: incoming.windowMinutes } : {}),
  }
}

/**
 * Compares two rate-limit payloads by their display fields.
 *
 * @param left First rate-limit payload.
 * @param right Second rate-limit payload.
 * @returns Whether both rolling windows are equivalent.
 */
function sameRateLimits(
  left: TokenPayload['rateLimits'],
  right: TokenPayload['rateLimits'],
): boolean {
  return (
    sameQuotaWindow(left?.fiveHour, right?.fiveHour) &&
    sameQuotaWindow(left?.sevenDay, right?.sevenDay)
  )
}

/**
 * Compares two quota windows by usage and reset metadata.
 *
 * @param left First quota window.
 * @param right Second quota window.
 * @returns Whether both windows are equivalent.
 */
function sameQuotaWindow(
  left: TokenRateLimitWindow | undefined,
  right: TokenRateLimitWindow | undefined,
): boolean {
  return (
    left?.usedPercent === right?.usedPercent &&
    left?.resetsAt === right?.resetsAt &&
    left?.windowMinutes === right?.windowMinutes
  )
}

/**
 * Converts an epoch-second or epoch-millisecond timestamp to milliseconds.
 *
 * @param value Reset timestamp.
 * @returns Epoch milliseconds.
 */
function normalizeResetAtMs(value: number): number {
  return value < 1_000_000_000_000 ? value * 1000 : value
}

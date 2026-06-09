/**
 * `@codepulse/core` — the platform-agnostic engine that turns a stream of
 * normalized events into live status and notifications.
 *
 * Exposes the event normalizer, the pure state-machine reducer, the rule
 * engine, the aggregation helpers, and the {@link StatusHub} that orchestrates
 * them. No Electron, HTTP, or database dependency lives here.
 *
 * @module core
 */
export * from './event-normalizer/index.js'
export * from './state-machine/index.js'
export * from './rule-engine/index.js'
export * from './aggregate/index.js'
export * from './hub/index.js'

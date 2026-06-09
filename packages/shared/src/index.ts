/**
 * `@codepulse/shared` — the framework-agnostic domain model shared by every
 * other package: agents, sessions, turns, events, token usage, runtime views,
 * and the local-server defaults.
 *
 * This package has no runtime dependencies and is safe to import from the main
 * process, the renderer, the server, and the hook scripts alike.
 *
 * @module shared
 */
export * from './types/agent.js'
export * from './types/state.js'
export * from './types/token.js'
export * from './types/session.js'
export * from './types/event.js'
export * from './types/runtime.js'

/** Default host the local HTTP/WebSocket server binds to (loopback only). */
export const DEFAULT_SERVER_HOST = '127.0.0.1'

/** Default port for the local HTTP/WebSocket server (requirements §5.9). */
export const DEFAULT_SERVER_PORT = 17888

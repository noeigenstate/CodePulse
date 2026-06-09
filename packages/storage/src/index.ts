/**
 * `@codepulse/storage` — SQLite persistence via `better-sqlite3` + Drizzle ORM.
 *
 * Exposes {@link openDb} to obtain a database handle, the Drizzle table
 * {@link schema}, and the {@link persistEvent} repository plus its read/prune
 * helpers. `better-sqlite3` is a native addon and must be built for the host
 * runtime's ABI (Node for tests, Electron for the app).
 *
 * @module storage
 */
export * from './sqlite/db.js'
export * from './sqlite/schema.js'
export * from './repository.js'

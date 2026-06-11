/**
 * `@codepulse/storage` —— 通过 `better-sqlite3` + Drizzle ORM 实现的
 * SQLite 持久化。
 *
 * 暴露 {@link openDb} 获取数据库句柄、Drizzle 表 {@link schema}，
 * 以及 {@link persistEvent} 仓储与读取/清理辅助函数。
 * `better-sqlite3` 是原生扩展，必须针对宿主运行时的 ABI 构建
 * （测试用 Node，应用用 Electron）。
 *
 * @module storage
 */
export * from './sqlite/db.js'
export * from './sqlite/schema.js'
export * from './repository.js'

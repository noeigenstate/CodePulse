/**
 * `@codepulse/shared` —— 与框架无关的领域模型，被其他所有包共享：
 * agent、会话（session）、轮次（turn）、事件、token 用量、运行时视图
 * 以及本地服务器默认配置。
 *
 * 本包没有任何运行时依赖，可以安全地被主进程、渲染进程、服务器
 * 以及 hook 脚本引用。
 *
 * @module shared
 */
export * from './types/agent.js'
export * from './types/state.js'
export * from './types/token.js'
export * from './types/session.js'
export * from './types/event.js'
export * from './types/timing.js'
export * from './types/runtime.js'
export * from './types/update.js'
export * from './types/stats.js'
export * from './token-format.js'
export * from './path.js'

/** 本地 HTTP/WebSocket 服务器绑定的默认主机（仅回环地址）。 */
export const DEFAULT_SERVER_HOST = '127.0.0.1'

/** 本地 HTTP/WebSocket 服务器的默认端口（需求 §5.9）。 */
export const DEFAULT_SERVER_PORT = 17888

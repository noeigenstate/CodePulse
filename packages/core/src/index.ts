/**
 * `@codepulse/core` —— 与平台无关的引擎，把归一化事件流转换为
 * 实时状态与通知。
 *
 * 暴露事件归一化器、纯状态机 reducer、规则引擎、聚合辅助函数，
 * 以及编排它们的 {@link StatusHub}。此处不依赖 Electron、HTTP
 * 或数据库。
 *
 * @module core
 */
export * from './event-normalizer/index.js'
export * from './state-machine/index.js'
export * from './rule-engine/index.js'
export * from './aggregate/index.js'
export * from './hub/index.js'

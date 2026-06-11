/**
 * agent 检测路由：报告支持的本地 AI agent CLI 是否已安装，
 * 以及 CodePulse 的 hook 是否看起来已配置。
 *
 * @module local-server/routes/agents
 */
import type { FastifyInstance } from 'fastify'
import { detectAgents } from '../agent-detect.js'

/** 注册 `GET /api/agents/detect`。 */
export function registerAgentRoutes(app: FastifyInstance): void {
  app.get('/api/agents/detect', async () => ({ agents: await detectAgents() }))
}

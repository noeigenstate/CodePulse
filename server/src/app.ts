import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth, RateLimiter } from './auth.js'
import { openDatabase } from './db.js'
import { seed } from './seed.js'
import { Generator } from './generate/index.js'
import {
  nodeTransport,
  resolveHost,
  type ResolveHost,
  type WebhookTransport,
} from './generate/webhook.js'
import { catalogRoutes } from './routes/catalog.js'
import { clientRoutes } from './routes/client.js'
import { installRoutes } from './routes/installs.js'
import { developerRoutes } from './routes/developer.js'
import { adminRoutes } from './routes/admin.js'
import type { Context } from './context.js'
import { HttpError } from './validation.js'

export interface AppOptions {
  dbPath?: string
  now?: () => number
  fetch?: typeof fetch
  resolveHost?: ResolveHost
  timeZone?: string
  allowHttpLoopbackWebhooks?: boolean
  webhookTransport?: WebhookTransport
  webDir?: string
}

export function buildApp(options: AppOptions = {}): FastifyInstance {
  const timeZone = options.timeZone ?? 'Asia/Shanghai'
  try {
    new Intl.DateTimeFormat('en', { timeZone })
  } catch {
    throw new Error('平台时区无效')
  }
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 })
  const db = openDatabase(
    options.dbPath ?? resolve(dirname(fileURLToPath(import.meta.url)), '../.data/platform.sqlite'),
  )
  const generation = {
    timeZone,
    now: options.now ?? Date.now,
    fetch: options.fetch ?? globalThis.fetch,
    resolveHost: options.resolveHost ?? resolveHost,
    allowHttpLoopbackWebhooks: options.allowHttpLoopbackWebhooks ?? false,
    webhookTransport: options.webhookTransport ?? nodeTransport,
  }
  const context: Context = {
    ...generation,
    db,
    auth: new Auth(db, generation.now),
    rate: new RateLimiter(generation.now),
    generator: new Generator(db, generation),
  }
  try {
    seed(db, generation.now())
  } catch (error) {
    db.close()
    throw error
  }
  app.addHook('onClose', async () => {
    db.close()
  })
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store')
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError)
      return reply.status(error.statusCode).send({ error: error.message })
    const status = (error as { statusCode?: number }).statusCode ?? 500
    return reply.status(status >= 400 && status < 500 ? status : 500).send({
      error: status === 413 ? '提交内容过大' : status < 500 ? '请求格式无效' : '服务暂时不可用',
    })
  })
  catalogRoutes(app, context)
  clientRoutes(app, context)
  installRoutes(app, context)
  developerRoutes(app, context)
  adminRoutes(app, context)
  if (options.webDir) app.register(fastifyStatic, { root: resolve(options.webDir), prefix: '/' })
  app.setNotFoundHandler((request, reply) => {
    if (
      options.webDir &&
      request.method === 'GET' &&
      !/^\/api(?:\/|\?|$)/.test(request.raw.url ?? '')
    )
      return reply.sendFile('index.html')
    return reply.status(404).send({ error: '页面不存在' })
  })
  return app
}

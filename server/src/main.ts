import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildApp } from './app.js'
import { openDatabase } from './db.js'
import { promoteAdmin } from './admin.js'

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// server/.env holds this deployment's settings; variables already set in the environment win.
const envFile = resolve(serverDir, '.env')
if (existsSync(envFile)) process.loadEnvFile(envFile)
const dbPath = process.env.CODEPULSE_PLATFORM_DB ?? resolve(serverDir, '.data/platform.sqlite')
const args = process.argv.slice(2)

try {
  if (args.length) {
    if (args[0] !== 'admin' || args.length !== 2 || !args[1].trim())
      throw new Error('用法：node dist/main.js admin <email>')
    const db = openDatabase(dbPath)
    try {
      promoteAdmin(db, args[1])
      console.log('已设为管理员')
    } finally {
      db.close()
    }
  } else {
    const port = Number(process.env.CODEPULSE_PLATFORM_PORT ?? 18080)
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 17888 || port === 17889)
      throw new Error('平台端口无效或与桌面服务冲突')
    const webDir = resolve(serverDir, 'dist/web')
    const app = buildApp({
      dbPath,
      timeZone: process.env.CODEPULSE_PLATFORM_TZ ?? 'Asia/Shanghai',
      allowHttpLoopbackWebhooks: process.env.CODEPULSE_PLATFORM_ALLOW_HTTP_WEBHOOK === '1',
      webDir: existsSync(resolve(webDir, 'index.html')) ? webDir : undefined,
    })
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void app.close().catch(() => {
          process.exitCode = 1
        })
      })
    }
    try {
      const address = await app.listen({
        host: process.env.CODEPULSE_PLATFORM_HOST ?? '127.0.0.1',
        port,
      })
      console.log(`CodePulse 插件平台：${address}`)
    } catch (error) {
      await app.close()
      throw error
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '启动失败')
  process.exitCode = 1
}

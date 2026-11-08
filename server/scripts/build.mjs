import { build, context } from 'esbuild'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const options = {
  absWorkingDir: root,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: true,
  external: ['fastify', '@fastify/static', 'better-sqlite3'],
  alias: { '@codepulse/shared': resolve(root, '../packages/shared/src/index.ts') },
}

if (!process.argv.includes('--watch')) {
  await build(options)
} else {
  let child
  let stopping = false
  const stopChild = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise((done) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      child.once('exit', () => {
        clearTimeout(timer)
        done()
      })
      child.kill('SIGTERM')
    })
  }
  const ctx = await context({
    ...options,
    plugins: [
      {
        name: 'restart-server',
        setup(buildContext) {
          buildContext.onEnd(async (result) => {
            if (result.errors.length || stopping) return
            await stopChild()
            if (stopping) return
            child = spawn(process.execPath, [resolve(root, 'dist/main.js')], {
              stdio: 'inherit',
              cwd: root,
            })
            child.on('error', (error) => console.error(error.message))
          })
        },
      },
    ],
  })
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      stopping = true
      await ctx.dispose()
      await stopChild()
    })
  }
  await ctx.watch()
}

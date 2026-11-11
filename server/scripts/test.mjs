import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outdir = resolve(root, '../.tmpshots/server-tests')
const tests = (await readdir(resolve(root, 'test'))).filter((file) => file.endsWith('.test.ts'))
if (!tests.length) throw new Error('未找到服务端测试')
await mkdir(outdir, { recursive: true })
// Test artifacts live outside server/, so resolve its separate Node ABI SQLite copy explicitly.
const require = createRequire(import.meta.url)
await build({
  entryPoints: Object.fromEntries([
    ...tests.map((file) => [file.replace(/\.ts$/, ''), resolve(root, 'test', file)]),
    ['main-cli', resolve(root, 'src/main.ts')],
  ]),
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  sourcemap: 'inline',
  external: ['fastify', '@fastify/static', 'better-sqlite3'],
  alias: {
    '@codepulse/shared': resolve(root, '../packages/shared/src/index.ts'),
  },
  plugins: [
    {
      name: 'server-sqlite',
      setup(ctx) {
        ctx.onResolve({ filter: /^better-sqlite3$/ }, () => ({
          path: pathToFileURL(require.resolve('better-sqlite3')).href,
          external: true,
        }))
      },
    },
  ],
})
const result = spawnSync(
  process.execPath,
  ['--test', ...tests.map((file) => resolve(outdir, file.replace(/\.ts$/, '.js')))],
  { stdio: 'inherit' },
)
process.exit(result.status ?? 1)

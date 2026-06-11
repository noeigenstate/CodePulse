// Bundles TypeScript tests against workspace source packages, then runs Node's
// built-in test runner. This keeps tests dependency-light and close to runtime.
import { spawnSync } from 'node:child_process'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { build } from 'esbuild'

const testsDir = resolve('tests')
const outdir = resolve(testsDir, '.generated')
const allTestFiles = (await readdir(testsDir)).filter(
  (file) => file.endsWith('.test.ts') || file.endsWith('.test.js'),
)
const tsTestFiles = allTestFiles
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => resolve(testsDir, file))
const jsTestFiles = allTestFiles
  .filter((file) => file.endsWith('.test.js'))
  .map((file) => resolve(testsDir, file))

if (allTestFiles.length === 0) {
  console.error('No tests/*.test.ts or tests/*.test.js files found')
  process.exit(1)
}

await mkdir(outdir, { recursive: true })

if (tsTestFiles.length > 0) {
  await build({
    entryPoints: tsTestFiles,
    bundle: true,
    platform: 'node',
    format: 'esm',
    sourcemap: 'inline',
    outdir,
    entryNames: '[name]',
    external: ['fastify', '@fastify/websocket', 'better-sqlite3'],
    alias: {
      '@codepulse/shared': './packages/shared/src/index.ts',
      '@codepulse/core': './packages/core/src/index.ts',
      '@codepulse/adapters': './packages/adapters/src/index.ts',
      '@codepulse/local-server': './packages/local-server/src/index.ts',
      '@codepulse/storage': './packages/storage/src/index.ts',
    },
  })
}

const generatedTests = tsTestFiles.map((file) =>
  resolve(outdir, `${basename(file, '.test.ts')}.test.js`),
)
const result = spawnSync(process.execPath, ['--test', ...generatedTests, ...jsTestFiles], {
  stdio: 'inherit',
})

process.exit(result.status ?? 1)

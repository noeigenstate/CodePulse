// Uses a disposable profile and synthetic data. Never launches production bootstrap.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const output = resolve('.tmpshots/surface-smoke')
mkdirSync(output, { recursive: true })
const bundle = resolve(output, 'harness.cjs')
await build({
  entryPoints: ['scripts/surface-smoke.ts'], outfile: bundle,
  platform: 'node', format: 'cjs', bundle: true,
  external: ['electron', 'better-sqlite3'],
  alias: {
    '@codepulse/shared': './packages/shared/src/index.ts',
    '@codepulse/core': './packages/core/src/index.ts',
  },
})
const env = { ...process.env, CODEPULSE_SMOKE_RUN: String(Date.now()) }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const result = spawnSync(electron, [bundle], { env, stdio: 'inherit', windowsHide: true, timeout: 150_000 })
if (result.error) throw result.error
if (result.status !== 0) {
  try { console.error(readFileSync(resolve(output, env.CODEPULSE_SMOKE_RUN, 'failure.txt'), 'utf8')) } catch {}
  process.exit(result.status ?? 1)
}
console.log(readFileSync(resolve(output, env.CODEPULSE_SMOKE_RUN, 'result.json'), 'utf8'))

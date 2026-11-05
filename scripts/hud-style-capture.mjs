// Usage: node scripts/hud-style-capture.mjs [--force-device-scale-factor=1]. Build first.
// Output: .tmpshots/hud-capture/shots (override with CODEPULSE_CAPTURE_OUT).
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const dir = resolve('.tmpshots/hud-capture')
mkdirSync(dir, { recursive: true })
const bundle = resolve(dir, 'harness.cjs')
await build({
  entryPoints: ['scripts/hud-style-capture.ts'],
  outfile: bundle,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  external: ['electron', 'better-sqlite3'],
  alias: {
    '@codepulse/shared': './packages/shared/src/index.ts',
    '@codepulse/core': './packages/core/src/index.ts',
  },
})
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const result = spawnSync(electron, [...process.argv.slice(2), bundle], {
  env,
  stdio: 'inherit',
  windowsHide: true,
  timeout: 300_000,
})
if (result.error) throw result.error
process.exit(result.status ?? 1)

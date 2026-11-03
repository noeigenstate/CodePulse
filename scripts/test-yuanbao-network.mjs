// Isolated Electron process + loopback server; never launches the product bootstrap.
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import electron from 'electron'

const output = resolve('.tmpshots/yb-review/network')
mkdirSync(output, { recursive: true })
const bundle = resolve(output, 'harness.cjs')
await build({
  entryPoints: ['scripts/yuanbao-network-check.ts'],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})
const env = { ...process.env, CODEPULSE_YUANBAO_NETWORK_OUTPUT: output }
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
const result = spawnSync(electron, [bundle], {
  env,
  windowsHide: true,
  stdio: 'inherit',
  timeout: 30000,
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(readFileSync(resolve(output, 'result.json'), 'utf8'))

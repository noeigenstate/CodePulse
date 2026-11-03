// SDK-free in-tree source/asset check. Never starts the app or accesses a device.
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolve, join, sep } from 'node:path'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const firmware = join(root, 'firmware')
const strict = process.argv.includes('--require-components')
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--require-components'),
  'Unknown argument',
)
assert.ok(!existsSync(join(firmware, '.git')), 'firmware must use the root Git repository')
const desktop = join(root, 'apps/desktop/src/renderer/src/device-preview')
const hud = join(root, 'apps/hud/src/renderer/src/device-preview')
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const bytes = (file) => readFileSync(file)
const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const manifest = JSON.parse(text(join(desktop, 'manifest.json')))
assert.equal(manifest.width, 400)
assert.equal(manifest.height, 300)
assert.equal(manifest.sourceHashFormat, 'sha256-text-lf')
for (const file of [
  'main/life_dashboard.c',
  'main/life_dashboard.h',
  'main/codepulse_life.h',
  'main/life_assets.generated.h',
  'scripts/generate-life-assets.py',
  'preview/life-icons.json',
  'fonts/sources/life-assets.json',
  'fonts/licenses/Terminus-OFL.txt',
]) {
  assert.ok(manifest.sources[file], `Life renderer source omitted from manifest: ${file}`)
}
assert.ok(
  ['Terminus native', 'ZhengGeDianHei', 'Fusion Pixel', 'Noto Sans Bold', 'Unifont'].every((name) =>
    text(join(desktop, 'THIRD-PARTY-NOTICES.txt')).includes(name),
  ),
  'Missing shipped native font attribution',
)
assert.equal(sha(bytes(join(desktop, 'renderer.wasm'))), manifest.wasmSha256)
assert.equal(sha(Buffer.from(text(join(desktop, 'renderer.b64')), 'base64')), manifest.wasmSha256)
for (const file of [
  'renderer.wasm',
  'renderer.b64',
  'renderer.mjs',
  'renderer.d.mts',
  'manifest.json',
  'THIRD-PARTY-NOTICES.txt',
]) {
  assert.deepEqual(
    bytes(join(desktop, file)),
    bytes(join(hud, file)),
    `Desktop/HUD mismatch: ${file}`,
  )
}
for (const app of ['desktop', 'hud']) {
  assert.deepEqual(
    bytes(join(desktop, 'THIRD-PARTY-NOTICES.txt')),
    bytes(join(root, `apps/${app}/src/renderer/public/device-preview-licenses.txt`)),
    `Public renderer notices differ: ${app}`,
  )
}
let checked = 0,
  deferred = 0
for (const [name, expected] of Object.entries(manifest.sources)) {
  const source = resolve(firmware, name)
  assert.ok(source.startsWith(resolve(firmware) + sep), `Unsafe manifest path: ${name}`)
  if (!existsSync(source) && name.startsWith('managed_components/') && !strict) {
    deferred++
    continue
  }
  assert.ok(
    existsSync(source),
    `Missing source: ${name}; configure locked ESP-IDF components if needed`,
  )
  assert.equal(
    sha(text(source)),
    expected,
    `Stale preview source: ${name}; regenerate both previews`,
  )
  checked++
}
assert.ok(
  text(join(firmware, 'CMakeLists.txt')).includes(`set(PROJECT_VER "${manifest.firmwareVersion}")`),
  'Default source/preview version differs',
)
console.log(
  `Firmware preview verified: ${manifest.firmwareVersion}; ${checked} source hashes, both 400x300 assets and public notices.`,
)
if (deferred)
  console.log(
    `${deferred} generated dependency hashes deferred; use --require-components after ESP-IDF configuration.`,
  )

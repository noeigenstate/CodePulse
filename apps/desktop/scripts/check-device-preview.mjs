import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')
// Git may check out text with CRLF on Windows and LF on other machines.
const sourceHash = path => createHash('sha256').update(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).digest('hex')
const assets = resolve('src/renderer/src/device-preview')
const manifest = JSON.parse(readFileSync(join(assets, 'manifest.json'), 'utf8'))
if (manifest.width !== 400 || manifest.height !== 300 || hash(join(assets, 'renderer.wasm')) !== manifest.wasmSha256) throw new Error('Invalid device preview asset; regenerate from firmware.')
if (createHash('sha256').update(Buffer.from(readFileSync(join(assets, 'renderer.b64'), 'ascii'), 'base64')).digest('hex') !== manifest.wasmSha256) throw new Error('Stale embedded renderer bytes.')
const firmware = process.env.CODEPULSE_FIRMWARE_SOURCE
if (firmware) {
  if (!existsSync(join(firmware, 'main/quiet_dashboard.c'))) throw new Error('Invalid CODEPULSE_FIRMWARE_SOURCE.')
  if (manifest.sourceHashFormat !== 'sha256-text-lf') throw new Error('Regenerate preview source hashes for portable checkout verification.')
  for (const [file, expected] of Object.entries(manifest.sources)) {
    const source = join(firmware, file === 'cJSON.c' ? 'managed_components/espressif__cjson/cJSON/cJSON.c' : file)
    if (!existsSync(source) || sourceHash(source) !== expected) throw new Error(`Stale device preview: ${file}. Rebuild with firmware/scripts/build-preview.py and sync-device-preview.ps1.`)
  }
}
// Check every byte used by either UI, including the adapter and font notices.
const hudAssets = resolve('../hud/src/renderer/src/device-preview')
for (const file of ['renderer.wasm', 'renderer.b64', 'renderer.mjs', 'renderer.d.mts', 'manifest.json', 'THIRD-PARTY-NOTICES.txt']) {
  if (hash(join(assets, file)) !== hash(join(hudAssets, file))) throw new Error(`Desktop/HUD preview mismatch: ${file}`)
}
console.log(`Device preview verified: ${manifest.firmwareVersion}, 400x300.`)

// Production WASM, no Electron bootstrap or device. Optional native executable for plane parity.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
const [wasmPath, outputPath, nativePath] = process.argv.slice(2)
const output = resolve(outputPath)
mkdirSync(output, { recursive: true })
const { createDevicePlaneRenderer } = await import(
  new URL('../../apps/desktop/src/renderer/src/device-preview/renderer.mjs', import.meta.url)
)
const render = await createDevicePlaneRenderer(new Uint8Array(readFileSync(wasmPath)))
for (const name of [
  'weather',
  'gold',
  'stock-down',
  'stock-up',
  'stock-closed',
  'tool-codex',
  'tool-claude',
  'news',
  'holiday-yes',
  'holiday-none',
]) {
  const path = new URL(`./fixtures/life-${name}.json`, import.meta.url)
  const input = JSON.parse(readFileSync(path, 'utf8')),
    planes = render(input)
  for (const color of ['black', 'red'])
    writeFileSync(join(output, name + '.' + color + '.bin'), planes[color])
  for (let i = 0; i < 15000; i++)
    assert.equal(planes.black[i] | planes.red[i], 255, `${name}: black/red overlap`)
  if (nativePath) {
    const inputFile = join(output, name + '.json')
    writeFileSync(inputFile, JSON.stringify(input))
    const black = join(output, name + '.native.black.bin'),
      red = join(output, name + '.native.red.bin')
    execFileSync(resolve(nativePath), [inputFile, black, red])
    assert.deepEqual(readFileSync(black), Buffer.from(planes.black), name + ': native black parity')
    assert.deepEqual(readFileSync(red), Buffer.from(planes.red), name + ': native red parity')
  }
}
console.log(
  'Rendered ten life fixtures; no black/red overlap' +
    (nativePath ? ', native/Wasm planes identical' : ''),
)

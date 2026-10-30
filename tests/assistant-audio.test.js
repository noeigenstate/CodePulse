import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { resolve, join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
const base = resolve('.tmpshots/assistant-audio-tests')
mkdirSync(base, { recursive: true })
const directory = mkdtempSync(join(base, 'case-')),
  file = join(directory, 'audio.mjs')
await build({
  entryPoints: ['apps/desktop/src/renderer/src/lib/assistantAudio.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: file,
})
const { resamplePcm } = await import(pathToFileURL(file).href)
after(() => {
  assert.ok(directory.startsWith(base + sep))
  rmSync(directory, { recursive: true, force: true })
})
test('recording converts correctly signed 16-bit little-endian PCM', () => {
  assert.deepEqual([...resamplePcm(new Float32Array([0, 1, -1]), 16000)], [0, 0, 255, 127, 0, 128])
})
test('48 kHz input is downsampled to mono 16 kHz and capture length is bounded', () => {
  const result = resamplePcm(new Float32Array([1, 1, 1, -1, -1, -1]), 48000)
  assert.deepEqual([...result], [255, 127, 0, 128])
  assert.equal(resamplePcm(new Float32Array(16000 * 31), 16000).length, 960000)
  assert.throws(() => resamplePcm(new Float32Array(10), 8000))
})

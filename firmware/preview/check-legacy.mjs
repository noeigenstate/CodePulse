// node preview/check-legacy.mjs native.exe output-dir [--update]
// Inputs are the original 65 BW + 11 red cases; expected pixels use 0.0.29.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
const [executable, directory, update] = process.argv.slice(2)
const native = resolve(executable), output = resolve(directory)
const input = gunzipSync(readFileSync(new URL('./baselines/legacy-inputs.json.gz', import.meta.url)))
const cases = Object.entries(JSON.parse(input)), hash = bytes => createHash('sha256').update(bytes).digest('hex')
assert.equal(cases.length, 76); assert.equal(cases.filter(([name]) => !name.startsWith('pet-')).length, 65)
mkdirSync(output, { recursive: true })
const pixels = {}
for (const [name, status] of cases) {
  const json = join(output, name + '.json'), black = join(output, name + '.black.bin'), red = join(output, name + '.red.bin')
  writeFileSync(json, JSON.stringify(status)); execFileSync(native, [json, black, red])
  const bw = readFileSync(black), color = readFileSync(red)
  assert.equal(bw.length, 15000); assert.equal(color.length, 15000)
  pixels[name] = { black: hash(bw), red: hash(color) }
}
const result = { firmwareVersion: '0.0.29-calendar', renderRevision: 'C-native-Noto-fullscreen-circle-white', originalInputs: 'f5e21fd (unchanged through 0.0.28)',
  inputSha256: hash(input), bwCases: 65, redCases: 11, pixels }
const baseline = new URL('./baselines/0.0.29-calendar.json', import.meta.url)
if (update === '--update') writeFileSync(baseline, JSON.stringify(result, null, 2) + '\n')
else assert.deepEqual(result, JSON.parse(readFileSync(baseline, 'utf8')), '0.0.29 pixel baseline changed; review before regenerating')
writeFileSync(join(output, 'summary.json'), JSON.stringify({ ...result, pixels: undefined, mismatches: 0 }, null, 2) + '\n')
console.log(`PASS: 65 original BW + 11 original red inputs match the 0.0.29 baseline (both planes)${update === '--update' ? '; baseline regenerated' : ''}`)

// Small, lossless subset of the same licensed native pixel strikes as the device firmware.
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
const source = new URL('../firmware/fonts/sources/', import.meta.url)
const target = fileURLToPath(
  new URL('../apps/desktop/src/main/performance-font.generated.json', import.meta.url),
)
const { faces } = JSON.parse(readFileSync(new URL('grid-native-masks.json', source), 'utf8'))
const bits = gunzipSync(readFileSync(new URL('grid-native-masks.bin.gz', source)))
const labels = '0123456789#%/.- CPUComputeDARGVIMBTi个逻辑核总占用内存显计算引擎'
const atlas = {}
for (const [size, name, charset] of [
  ['label', 'pixel-16', labels],
  ['number', 'terminus-18b', '0123456789%.-/ GBi'],
  ['large', 'hero-40', '0123456789%-'],
  ['hero', 'hero-56', '0123456789%-'],
]) {
  const face = faces.find((f) => f.name === name)
  const glyphs = {}
  for (const ch of new Set(charset)) {
    const n = face.codes.indexOf(ch.codePointAt(0))
    if (n < 0) throw new Error(name + ': missing ' + ch)
    const record = face.offset + n * 10,
      start = bits.readUInt32LE(record)
    let advance = bits.readUInt16LE(record + 4) / 64
    if (ch === ' ') advance = Math.ceil(advance / 2)
    const left = bits.readInt8(record + 6),
      top = bits.readInt8(record + 7)
    const w = bits[record + 8],
      h = bits[record + 9]
    glyphs[ch] = [
      advance,
      left,
      top,
      w,
      h,
      bits.subarray(start, start + Math.ceil(w / 8) * h).toString('base64'),
    ]
  }
  atlas[size] = glyphs
}
const json = JSON.stringify(atlas) + '\n'
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').trimEnd() !== json.trimEnd())
    throw new Error('Performance font is stale')
} else writeFileSync(target, json)

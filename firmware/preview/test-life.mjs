// Real C parser + native/Wasm renderer: schema fallbacks, unsupported text, inversion and stale clearing.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
const [wasmPath, nativePath, directory] = process.argv.slice(2)
const output = resolve(directory)
mkdirSync(output, { recursive: true })
const { createDevicePlaneRenderer } = await import(
  new URL('../../apps/desktop/src/renderer/src/device-preview/renderer.mjs', import.meta.url)
)
const render = await createDevicePlaneRenderer(new Uint8Array(readFileSync(wasmPath)))
let count = 0,
  fallBacks = 0
function parity(input) {
  const result = render(input),
    path = join(output, 'case-' + count + '.json'),
    black = join(output, 'case-' + count + '.black.bin'),
    red = join(output, 'case-' + count + '.red.bin')
  writeFileSync(path, JSON.stringify(input))
  execFileSync(resolve(nativePath), [path, black, red])
  assert.deepEqual(
    Buffer.from(result.black),
    readFileSync(black),
    'native/Wasm black case ' + count,
  )
  assert.deepEqual(Buffer.from(result.red), readFileSync(red), 'native/Wasm red case ' + count)
  for (let i = 0; i < 15000; i++) assert.equal(result.black[i] | result.red[i], 255)
  count++
  return result
}
function fallback(input) {
  const plain = structuredClone(input)
  delete plain.ambient.layout
  delete plain.ambient.life
  assert.deepEqual(
    parity(input),
    render(plain),
    'malformed life must render the unchanged text card',
  )
  fallBacks++
}
const names = [
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
  'concept',
  'concept-long',
  'prompt',
  'hn',
]
for (const name of names) {
  const input = JSON.parse(
    readFileSync(new URL('./fixtures/life-' + name + '.json', import.meta.url), 'utf8'),
  )
  const original = structuredClone(input),
    normal = parity(input)
  assert.deepEqual(input, original, 'render mutated the life payload')
  const inverse = structuredClone(input)
  inverse.display.inverted = true
  const inverted = parity(inverse)
  assert.deepEqual(inverted.red, normal.red)
  for (let i = 0; i < 15000; i++)
    assert.equal(inverted.black[i], (normal.black[i] ^ 255) | (normal.red[i] ^ 255))
  for (const key of Object.keys(input.ambient.life).filter(
    (k) => !['tomorrow', 'range'].includes(k),
  )) {
    const bad = structuredClone(input)
    delete bad.ambient.life[key]
    fallback(bad)
  }
  for (const life of [null, [], true, 'future', { ...input.ambient.life, v: 2 }])
    fallback({ ...input, ambient: { ...input.ambient, life } })
  const unsupported = structuredClone(input),
    p = unsupported.ambient.life
  if (p.kind === 'news') p.headlines[0].title = '😀'
  else if (p.kind === 'concept') p.term = '😀'
  else if (p.kind === 'prompt') p.question = ['😀']
  else if (p.kind === 'hn') p.stories[0].title = '😀'
  else if (p.kind === 'holiday') p.next.name = '😀'
  else if (p.kind === 'weather') p.condition = '😀'
  else p.source = '😀'
  fallback(unsupported)
  const unknown = structuredClone(input)
  unknown.ambient.layout = 'future-life'
  fallback(unknown)
}
const stock = JSON.parse(
  readFileSync(new URL('./fixtures/life-stock-up.json', import.meta.url), 'utf8'),
)
for (const hero of ['NaN', '12%', '１２３', '9999999999.1234'])
  fallback({ ...stock, ambient: { ...stock.ambient, life: { ...stock.ambient.life, hero } } })
const noImage = structuredClone(stock)
noImage.ambient.imageHex = '00'.repeat((384 * 208) / 8)
const picture = structuredClone(noImage)
delete picture.ambient.life
delete picture.ambient.layout
assert.deepEqual(
  parity(noImage),
  render(picture),
  'life must not bypass existing bitmap validation/presentation',
)
assert.throws(() => render({ ...stock, ambient: { ...stock.ambient, imageHex: 'bad' } }))
for (let i = 0; i < 40; i++) {
  const bad = structuredClone(stock)
  bad.ambient.life.headlines = []
  bad.ambient.life.kind = 'news'
  fallback(bad)
  assert.deepEqual(render(stock), render(structuredClone(stock)))
}
writeFileSync(
  join(output, 'summary.json'),
  JSON.stringify(
    {
      passed: true,
      nativeWasmCases: count,
      textFallbacks: fallBacks,
      headerFooter: 'unchanged',
      blackRedOverlap: 0,
    },
    null,
    2,
  ) + '\n',
)
console.log(
  `PASS life native/Wasm: ${count} cases, ${fallBacks} atomic text fallbacks, unsupported glyphs, black/red exclusion, inversion and alternating malformed/valid data`,
)

// node preview/render-r2.mjs renderer.wasm output-dir (pet planes in output-dir/pets)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { planeRenderer, rgbPlanes, png } from './render-utils.mjs'
const [wasm, output] = process.argv.slice(2).map(p => resolve(p))
const render = await planeRenderer(readFileSync(wasm))
const fixture = name => JSON.parse(readFileSync(new URL('./fixtures/' + name + '.json', import.meta.url), 'utf8'))
mkdirSync(output, { recursive: true })
const images = []
function save(name, status) {
  const planes = render(status), rgb = rgbPlanes(planes)
  writeFileSync(join(output, name + '.json'), JSON.stringify(status, null, 2) + '\n')
  writeFileSync(join(output, name + '.black.bin'), planes.black); writeFileSync(join(output, name + '.red.bin'), planes.red)
  writeFileSync(join(output, name + '.png'), png(rgb, 400, 300)); images.push([name, rgb])
}
for (const month of ['2026-10', '2026-02', '2026-08', '2027-02']) save('calendar-' + month, fixture('calendar-' + month))
const inverse = fixture('calendar-2026-10'); inverse.display.inverted = true
save('calendar-inverted', inverse)
for (const [id, mood] of [['tuantuan', 'idle'], ['yaya', 'working'], ['fangfang', 'happy']]) {
  const name = `${id}-${mood}`
  const rgb = rgbPlanes({ black: readFileSync(join(output, 'pets', name + '.black.bin')),
    red: readFileSync(join(output, 'pets', name + '.red.bin')) })
  writeFileSync(join(output, 'pet-' + id + '.png'), png(rgb, 400, 300)); images.push(['pet-' + id, rgb])
}
save('hud-one', fixture('hud-1')); save('hud-nine', fixture('hud-9')); save('usage', fixture('usage'))
const max = fixture('usage'); max.display.metric = 'used'
for (const agent of max.agents) agent.quotaSummary = { fiveHourUsedPercent: 100, weeklyUsedPercent: 100 }
save('usage-max', max)
const width = 2400, height = Math.ceil(images.length / 3) * 600, overview = Buffer.alloc(width * height * 3, 255)
for (const [index, [, rgb]] of images.entries()) for (let y = 0; y < 300; y++) for (let x = 0; x < 400; x++) {
  const source = (y * 400 + x) * 3, destX = (index % 3) * 800 + x * 2, destY = Math.floor(index / 3) * 600 + y * 2
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) rgb.copy(overview, ((destY + dy) * width + destX + dx) * 3, source, source + 3)
}
writeFileSync(join(output, 'overview.png'), png(overview, width, height))
writeFileSync(join(output, 'image-paths.txt'), [...images.map(([name]) => join(output, name + '.png')), join(output, 'overview.png')].join('\n') + '\n')
console.log(`PASS: ${images.length} native-resolution scenes and ${width}x${height} 2x nearest-neighbor overview`)
